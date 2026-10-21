import { data, redirect } from "react-router";

// Every page's data and form actions live in the Rust server, at /api plus the
// page's own path. These helpers are what each route's clientLoader and
// clientAction call.

function apiUrl(request: Request, path?: string): string {
  const url = new URL(request.url);
  return `/api${path ?? url.pathname}${path ? "" : url.search}`;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") return body.error;
  } catch {
    // Not JSON, fall through to the status text.
  }
  return res.statusText || `Request failed (${res.status})`;
}

/** Load a page's data. A 404 shows the not found page. */
export async function apiLoad<T>(request: Request, path?: string): Promise<T> {
  const res = await fetch(apiUrl(request, path), { signal: request.signal });
  if (res.status === 404) throw data("Not found", { status: 404 });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

/** Send a page's form to its action. The status comes back with the result,
    since a failed action shouldn't make the page reload its data. */
export async function apiAction<T>(request: Request, path?: string) {
  const form = await request.formData();
  const body = new URLSearchParams();
  for (const [key, value] of form) {
    if (typeof value === "string") body.append(key, value);
  }
  const res = await fetch(apiUrl(request, path), {
    method: "POST",
    body,
    signal: request.signal,
  });
  if (res.status === 404) throw data("Not found", { status: 404 });
  if (res.status >= 500) throw new Error(await readError(res));
  const json = await res.json();
  if (json && typeof json === "object" && typeof json.redirect === "string") {
    throw redirect(json.redirect);
  }
  return data(json as T, { status: res.status });
}
