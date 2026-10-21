"use client";

import React from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

import { safePhotoUrl } from "@/lib/whatsapp-photo-utils";
export { safePhotoUrl } from "@/lib/whatsapp-photo-utils";

export function getInitials(name?: string | null): string {
  if (!name || typeof name !== "string") return "L";
  const trimmed = name.trim();
  if (!trimmed) return "L";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.substring(0, 2).toUpperCase();
}

export interface LeadAvatarProps {
  url?: string | null;
  name?: string | null;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
  size?: "default" | "sm" | "lg";
}

export function LeadAvatar({
  url,
  name,
  className,
  imageClassName,
  fallbackClassName,
  size = "default",
}: LeadAvatarProps) {
  const safeUrl = safePhotoUrl(url);
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const initials = getInitials(name);

  return (
    <Avatar key={safeUrl === failedUrl ? "fallback" : safeUrl} size={size} className={cn("overflow-hidden shrink-0", className)}>
      {safeUrl && safeUrl !== failedUrl ? (
        <AvatarImage
          src={safeUrl}
          alt={name || "Lead"}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailedUrl(safeUrl)}
          className={cn("object-cover size-full", imageClassName)}
          render={(props) => <img {...props} referrerPolicy="no-referrer" />}
        />
      ) : null}
      <AvatarFallback className={cn("font-bold text-xs uppercase select-none", fallbackClassName)}>
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
