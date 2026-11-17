import { Suspense, lazy, type ComponentType, type ReactNode } from "react";

interface DynamicOptions {
  loading?: () => ReactNode;
  ssr?: boolean;
}

type Loader<P> = () => Promise<{ default: ComponentType<P> } | ComponentType<P>>;

export default function dynamic<P extends object>(loader: Loader<P>, options?: DynamicOptions): ComponentType<P> {
  const LazyComponent = lazy(async () => {
    const loaded = await loader();
    return "default" in loaded ? loaded : { default: loaded };
  });

  function DynamicWrapper(props: P): ReactNode {
    return (
      <Suspense fallback={options?.loading ? options.loading() : null}>
        <LazyComponent {...props} />
      </Suspense>
    );
  }

  return DynamicWrapper;
}

