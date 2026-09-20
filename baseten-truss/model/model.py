"""TripoSR on Baseten: one photo in, one .glb 3D model out.

Request body (JSON):
    image              required  the photo as a base64 string (a "data:image/...;base64," prefix is fine)
    remove_background  optional  default true. Cuts the subject out of its background first.
    foreground_ratio   optional  default 0.85. How much of the frame the cut-out fills (0.5 - 1.0).
    mc_resolution      optional  default 256. Mesh detail (64 - 512). Higher = sharper but slower.

Response body (JSON):
    { "format": "glb", "glb_base64": "<base64 of the .glb file>" }
"""
import base64
import io
import sys
import time

sys.path.insert(0, "/app/TripoSR")   # cloned in config.yaml -> build_commands


def _marching_cubes_numpy(vol, thresh):
    """Marching cubes with scikit-image, arranged to match what `torchmcubes` returns.

    TripoSR calls torchmcubes.marching_cubes(vol, thresh) and then reorders the vertices with [2, 1, 0]. torchmcubes
    returns vertex coordinates as (c, b, a) for a volume indexed vol[a, b, c], while scikit-image returns (a, b, c),
    so the vertex columns are reversed here. Faces are reversed too so the surface faces outward after TripoSR's
    reordering (checked with a synthetic ellipsoid: axis lengths and outward orientation both come out right).
    """
    import numpy as np
    from skimage import measure

    verts, faces, _, _ = measure.marching_cubes(np.asarray(vol, dtype=np.float32), level=float(thresh))
    verts = np.ascontiguousarray(verts[:, ::-1]).astype(np.float32)
    faces = np.ascontiguousarray(faces[:, ::-1]).astype(np.int64)
    return verts, faces


def _install_marching_cubes_fallback():
    """torchmcubes has to be compiled against torch (and, for CUDA torch, a CUDA toolkit the Baseten build image does
    not have), so we do not build it. TripoSR only needs its marching_cubes(), which we provide with scikit-image."""
    try:
        import torchmcubes  # noqa: F401  (use the real one if it happens to be installed)
        return
    except Exception:
        pass
    import types

    import torch

    def marching_cubes(vol, thresh):
        verts, faces = _marching_cubes_numpy(vol.detach().float().cpu().numpy(), thresh)
        return torch.from_numpy(verts), torch.from_numpy(faces)

    shim = types.ModuleType("torchmcubes")
    shim.marching_cubes = marching_cubes
    sys.modules["torchmcubes"] = shim
    print("torchmcubes not installed: using the scikit-image marching cubes fallback", flush=True)


class Model:
    def __init__(self, **kwargs):
        self._config = kwargs.get("config")
        self._model = None
        self._rembg = None
        self._device = None

    def load(self):
        # Runs once when a replica starts (weights are downloaded from Hugging Face the first time).
        import rembg
        import torch

        _install_marching_cubes_fallback()
        from tsr.system import TSR

        self._device = "cuda:0" if torch.cuda.is_available() else "cpu"
        model = TSR.from_pretrained(
            "stabilityai/TripoSR",
            config_name="config.yaml",
            weight_name="model.ckpt",
        )
        model.renderer.set_chunk_size(8192)
        model.to(self._device)
        self._model = model
        self._rembg = rembg.new_session()
        print(f"TripoSR loaded on {self._device}", flush=True)

    # ---- helpers ----
    @staticmethod
    def _decode_image(value):
        from PIL import Image

        if not isinstance(value, str) or not value:
            raise ValueError("'image' must be a base64 string")
        if value.startswith("data:"):
            value = value.split(",", 1)[1]
        img = Image.open(io.BytesIO(base64.b64decode(value)))
        img.load()
        return img

    def _prepare(self, img, remove_background, foreground_ratio):
        import numpy as np
        from PIL import Image
        from tsr.utils import remove_background as rm_bg, resize_foreground

        if remove_background:
            img = rm_bg(img.convert("RGBA"), self._rembg)
            img = resize_foreground(img, foreground_ratio)
            arr = np.array(img).astype(np.float32) / 255.0
            arr = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5   # composite on mid-grey, as TripoSR expects
            return Image.fromarray((arr * 255.0).astype(np.uint8))
        if img.mode == "RGBA":   # already cut out: composite on grey
            arr = np.array(img).astype(np.float32) / 255.0
            arr = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5
            return Image.fromarray((arr * 255.0).astype(np.uint8))
        return img.convert("RGB")

    # ---- request handler ----
    def predict(self, model_input):
        import torch
        from tsr.utils import to_gradio_3d_orientation

        t0 = time.time()
        img = self._decode_image(model_input.get("image"))
        remove_bg = bool(model_input.get("remove_background", True))
        ratio = min(1.0, max(0.5, float(model_input.get("foreground_ratio", 0.85))))
        res = int(min(512, max(64, int(model_input.get("mc_resolution", 256)))))

        image = self._prepare(img, remove_bg, ratio)
        with torch.no_grad():
            scene_codes = self._model([image], device=self._device)
            try:
                mesh = self._model.extract_mesh(scene_codes, True, resolution=res)[0]
            except (ValueError, RuntimeError) as e:
                if "surface" not in str(e).lower():
                    raise   # a real failure (e.g. out of memory), let it show up in the Baseten logs
                # marching cubes found no surface: the photo produced an empty shape
                return {"error": "No 3D shape could be built from this photo. Try a clearer photo of a single building."}
        if len(mesh.faces) and mesh.volume < 0:   # inside-out mesh: flip it so the walls face outward
            mesh.invert()
        mesh = to_gradio_3d_orientation(mesh)   # Y-up, facing the camera: what glTF viewers expect

        glb = mesh.export(file_type="glb")
        if hasattr(glb, "read"):
            glb = glb.read()
        print(f"TripoSR: {len(mesh.faces)} faces, {len(glb) / 1e6:.1f} MB, {time.time() - t0:.1f}s", flush=True)
        return {"format": "glb", "glb_base64": base64.b64encode(glb).decode("ascii")}