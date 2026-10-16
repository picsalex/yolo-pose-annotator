"""Load a forklift GLB: its parts as meshes (world coordinates) and its keypoints,
the nodes named kp_<index>_<name>."""
from dataclasses import dataclass, field

import numpy as np
import pyvista as pv
import trimesh

KEYPOINT_PREFIX = "kp_"


@dataclass
class Keypoint:
    index: int
    name: str
    position: np.ndarray


@dataclass
class ForkliftModel:
    parts: list = field(default_factory=list)       # (node name, pv.PolyData, rgba)
    keypoints: list = field(default_factory=list)   # [Keypoint], sorted by index


def load_model(path):
    """Split a GLB into coloured meshes and keypoints (world coordinates)."""
    scene = trimesh.load(path, force="scene")
    model = ForkliftModel()
    for node in scene.graph.nodes_geometry:
        transform, geom_name = scene.graph[node]
        if node.startswith(KEYPOINT_PREFIX):
            index, name = node[len(KEYPOINT_PREFIX):].split("_", 1)
            model.keypoints.append(Keypoint(int(index), name, transform[:3, 3].copy()))
            continue
        mesh = scene.geometry[geom_name].copy()
        mesh.apply_transform(transform)
        model.parts.append((node, pv.wrap(mesh), _mesh_color(mesh)))
    model.keypoints.sort(key=lambda k: k.index)
    return model


def _mesh_color(mesh):
    material = getattr(mesh.visual, "material", None)
    color = getattr(material, "baseColorFactor", None)
    if color is None:
        return (0.7, 0.7, 0.7, 1.0)
    return tuple(np.asarray(color, float) / 255.0)
