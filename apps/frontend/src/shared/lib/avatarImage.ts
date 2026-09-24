// Centre-cropped and drawn at the stored size, so a photo is kept in a few kilobytes.
import { AVATAR_SIZE_PX } from "@nightwarden/shared";

export async function avatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE_PX;
  canvas.height = AVATAR_SIZE_PX;
  const context = canvas.getContext("2d");
  if (context === null)
    throw new Error("This browser cannot draw the picture.");
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE_PX,
    AVATAR_SIZE_PX,
  );
  bitmap.close();
  return canvas.toDataURL("image/webp", 0.9);
}
