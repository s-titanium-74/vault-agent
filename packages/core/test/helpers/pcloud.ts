/** Synthetic HTTP service shared by adapter and cross-runtime contract tests. */
export class SyntheticPCloud {
  files = new Map<string, { text: string; hash: string; fileid: number }>();
  requests: { host: string; method: string; params: URLSearchParams }[] = [];
  failure: number | null = null;
  partial = false;
  downloadHost = "c1.pcloud.com";
  onDownload?: () => void;
  private serial = 10;
  set(path: string, text: string) {
    this.files.set(path, {
      text,
      fileid: this.files.get(path)?.fileid ?? ++this.serial,
      hash: `1844674407370955${String(++this.serial).padStart(4, "0")}`,
    });
  }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const params = new URLSearchParams(String(init?.body ?? ""));
    this.requests.push({ host: url.host, method: url.pathname, params });
    if (init?.signal?.aborted) throw new Error("secret transport error");
    if (this.failure !== null)
      return Response.json({
        result: this.failure,
        error: "synthetic private provider text",
      });
    if (url.host === "c1.pcloud.com") {
      const file = [...this.files.values()].find(
        (f) => f.fileid === Number(url.pathname.slice(1)),
      );
      const text = file?.text;
      this.onDownload?.();
      return new Response(text, { status: file ? 200 : 404 });
    }
    if (url.pathname === "/getfilelink")
      return Response.json({
        result: 0,
        hosts: [this.downloadHost],
        path: `/${params.get("fileid")}`,
      });
    if (params.has("nofiles"))
      throw new Error("nofiles is a presence flag and would hide all notes");
    if (url.pathname !== "/listfolder")
      throw new Error("Unexpected API mutation");
    const folders = [
      "",
      ...new Set(
        [...this.files.keys()].flatMap((p) =>
          p
            .split("/")
            .slice(0, -1)
            .map((_, i) =>
              p
                .split("/")
                .slice(0, i + 1)
                .join("/"),
            ),
        ),
      ),
    ].sort();
    const folderId = (p: string) => (p === "" ? 1 : folders.indexOf(p) + 100);
    const build = (
      prefix: string,
      recursive: boolean,
    ): Record<string, unknown> => ({
      isfolder: true,
      folderid: folderId(prefix),
      name: prefix.split("/").at(-1),
      contents: [
        ...folders
          .filter((p) => p && p.split("/").slice(0, -1).join("/") === prefix)
          .map((p) => ({
            ...(recursive
              ? build(p, true)
              : {
                  isfolder: true,
                  folderid: folderId(p),
                  name: p.split("/").at(-1),
                }),
            parentfolderid: folderId(prefix),
          })),
        ...[...this.files]
          .filter(([p]) => p.split("/").slice(0, -1).join("/") === prefix)
          .map(([p, f]) => ({
            isfolder: false,
            name: p.split("/").at(-1),
            parentfolderid: folderId(prefix),
            fileid: f.fileid,
            size: new TextEncoder().encode(f.text).length,
            hash: f.hash,
            modified: "Mon, 02 Nov 2026 00:00:00 +0000",
          })),
      ],
    });
    const prefix = folders.find(
      (p) => folderId(p) === Number(params.get("folderid")),
    );
    if (prefix === undefined) return Response.json({ result: 2002 });
    const metadata = build(prefix, params.get("recursive") === "1");
    if (this.partial) delete metadata.contents;
    return new Response(
      JSON.stringify({ result: 0, metadata }).replace(
        /"hash":"(\d+)"/g,
        '"hash":$1',
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  };
}
