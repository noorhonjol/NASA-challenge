/** Illustrative Earth face from NASA Blue Marble, not a time-resolved Earth rotation model. */
export async function makeSkyImages() {
  const image = new Image();
  image.src = "/textures/earth-blue-marble.jpg";
  await image.decode();
  const texture = document.createElement("canvas");
  texture.width = image.width; texture.height = image.height;
  const source = texture.getContext("2d")!;
  source.drawImage(image, 0, 0);
  const pixels = source.getImageData(0, 0, image.width, image.height).data;
  const earth = document.createElement("canvas");
  earth.width = earth.height = 256;
  const ctx = earth.getContext("2d")!;
  const output = ctx.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const sx = (x - 127.5) / 126, sy = (127.5 - y) / 126;
    const r2 = sx * sx + sy * sy;
    if (r2 > 1) continue;
    const z = Math.sqrt(1 - r2);
    const lon = Math.atan2(sx, z), lat = Math.asin(sy);
    const tx = Math.min(image.width - 1, Math.floor((lon / (2 * Math.PI) + 0.5) * image.width));
    const ty = Math.min(image.height - 1, Math.floor((0.5 - lat / Math.PI) * image.height));
    const src = (ty * image.width + tx) * 4, dst = (y * 256 + x) * 4;
    const shade = 0.65 + 0.35 * z;
    for (let c = 0; c < 3; c++) output.data[dst + c] = pixels[src + c] * shade;
    output.data[dst + 3] = 255;
  }
  ctx.putImageData(output, 0, 0);
  const sun = document.createElement("canvas");
  sun.width = sun.height = 128;
  const g = sun.getContext("2d")!;
  const glow = g.createRadialGradient(64, 64, 18, 64, 64, 64);
  glow.addColorStop(0, "#fffbe8"); glow.addColorStop(0.35, "#ffd166aa"); glow.addColorStop(1, "#ffd16600");
  g.fillStyle = glow; g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#fffbe8"; g.beginPath(); g.arc(64, 64, 18, 0, Math.PI * 2); g.fill();
  return { earth, sun };
}
