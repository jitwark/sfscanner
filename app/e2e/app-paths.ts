const configuredBasePath = (
  process.env.PLAYWRIGHT_BASE_PATH
  ?? process.env.NEXT_PUBLIC_BASE_PATH
  ?? ''
).replace(/^\/+|\/+$/g, '');

export const basePath = configuredBasePath ? `/${configuredBasePath}` : '';

export function appPath(pathname: string): string {
  return `${basePath}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
