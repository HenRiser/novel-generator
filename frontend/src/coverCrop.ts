export type CoverCropControls = { size: number; horizontal: number; vertical: number };
export type CoverCropRect = { x: number; y: number; width: number; height: number };
export const initialCoverCrop: CoverCropControls = { size: 100, horizontal: 50, vertical: 50 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Whole source pixels keep every saved candidate exactly 2:3, including small images. */
export function coverCropRect(width: number, height: number, controls: CoverCropControls): CoverCropRect {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 3 ||
      ![controls.size, controls.horizontal, controls.vertical].every(Number.isFinite)) throw new Error('图片过小或裁剪参数无效，至少需要 2 × 3 像素。');
  const unit = Math.max(1, Math.floor(Math.min(width / 2, height / 3) * clamp(controls.size, 20, 100) / 100));
  const cropWidth = unit * 2, cropHeight = unit * 3;
  return { x: Math.round((width - cropWidth) * clamp(controls.horizontal, 0, 100) / 100),
    y: Math.round((height - cropHeight) * clamp(controls.vertical, 0, 100) / 100), width: cropWidth, height: cropHeight };
}

export async function cropCoverBlob(blob: Blob, rect: CoverCropRect): Promise<Blob> {
  const image = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) || rect.width < 2 || rect.height < 3 || rect.width * 3 !== rect.height * 2 ||
        rect.x < 0 || rect.y < 0 || rect.x + rect.width > image.width || rect.y + rect.height > image.height) throw new Error('裁剪范围超出图片边界，请重新选择。');
    const unit = Math.min(rect.width / 2, 1024), canvas = document.createElement('canvas');
    canvas.width = unit * 2; canvas.height = unit * 3;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法裁剪图片，请使用新版浏览器。');
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('裁剪图片未能保存，请重试。')), 'image/png'));
  } finally { image.close(); }
}
