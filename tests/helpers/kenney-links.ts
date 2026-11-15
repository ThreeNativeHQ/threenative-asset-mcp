/** Kenney's signed-link step (src/kenney/download-link.ts), answered so a test's own fake serves the archive. */
export function withKenneyLinks(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const id = /^\/download-link\/([0-9a-f]+)$/.exec(url.pathname)?.[1];
    if (url.hostname !== "kenney.nl" || !id) return fetch(input, init);
    return Response.json({
      url: `https://kenney.nl/download/${id}/${"a".repeat(64)}?expires=1794773763`,
    });
  };
}
