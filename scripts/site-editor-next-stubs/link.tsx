import type { AnchorHTMLAttributes, ReactNode } from "react";

interface UrlObject {
  pathname?: string | null;
}

interface LinkStubProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string | UrlObject;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
}

const LINK_OMIT = new Set(["prefetch", "replace", "scroll"]);

export default function Link({
  href,
  children,
  ...props
}: LinkStubProps): ReactNode {
  const resolved = typeof href === "string" ? href : href.pathname ?? "#";
  const anchorProps = Object.fromEntries(
    Object.entries(props).filter(([key]) => !LINK_OMIT.has(key))
  ) as Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">;
  return (
    <a href={resolved} {...anchorProps}>
      {children}
    </a>
  );
}
