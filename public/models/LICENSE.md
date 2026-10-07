# Body surface model

`body.json` is derived from **Cesium Man**, from the Khronos glTF sample assets:

https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan

© 2017 Cesium. Licensed under the Creative Commons Attribution 4.0
International license (CC-BY 4.0):
https://creativecommons.org/licenses/by/4.0/legalcode

Changes made: only the mesh geometry (positions, normals, triangles) is kept;
the texture, which carries the Cesium logo, the skin and the animation are
dropped. The mesh is rotated into the patient's RAS axes, scaled to a 1700 mm
stature, and cut across at half its height, the legs removed, so it is a bust.
The conversion is `tools/body-from-gltf.mjs`.
