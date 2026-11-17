function getPathname(): string {
  return typeof window === "undefined" ? "/sites/test-project" : window.location.pathname || "/sites/test-project";
}

export function usePathname(): string {
  const pathname = getPathname();
  return pathname === "/" ? "/sites/test-project" : pathname;
}

export function useParams<T extends Record<string, string | string[]> = Record<string, string>>(): T {
  const match = /^\/sites\/([^/]+)/.exec(usePathname());
  const projectId = match?.[1] ? decodeURIComponent(match[1]) : "test-project";
  return { projectId } as unknown as T;
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
}

interface RouterStub {
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string) => Promise<void>;
}

const STATIC_ROUTER: RouterStub = {
  push: (href: string) => {
    if (typeof window !== "undefined") window.history.pushState(null, "", href);
  },
  replace: (href: string) => {
    if (typeof window !== "undefined") window.history.replaceState(null, "", href);
  },
  back: () => {
    if (typeof window !== "undefined") window.history.back();
  },
  forward: () => {
    if (typeof window !== "undefined") window.history.forward();
  },
  refresh: () => undefined,
  prefetch: async () => undefined,
};

export function useRouter(): RouterStub {
  return STATIC_ROUTER;
}

export function notFound(): never {
  throw new Error("next/navigation notFound() invoked in stub");
}

export function redirect(url: string): never {
  throw new Error(`next/navigation redirect(${url}) invoked in stub`);
}

