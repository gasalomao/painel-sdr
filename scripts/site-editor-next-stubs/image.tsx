/* eslint-disable @next/next/no-img-element */
import type { ImgHTMLAttributes, ReactNode } from "react";

interface ImageStubProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  src: string | { src: string };
  fill?: boolean;
  priority?: boolean;
  unoptimized?: boolean;
  quality?: number;
}

const IMAGE_OMIT = new Set(["fill", "priority", "unoptimized", "quality"]);

export default function Image({
  src,
  alt = "",
  ...props
}: ImageStubProps): ReactNode {
  const resolved = typeof src === "string" ? src : src.src;
  const imgProps = Object.fromEntries(
    Object.entries(props).filter(([key]) => !IMAGE_OMIT.has(key))
  ) as Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt">;
  return <img src={resolved} alt={alt} {...imgProps} />;
}
