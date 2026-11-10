/** Synthetic HTTP service shared by adapter and cross-runtime contract tests. */
export class SyntheticPCloud {
  files = new Map<
    string,
    {
      text: string;
      bytes?: Uint8Array<ArrayBuffer>;
      hash: string;
      fileid: number;
    }
  >();
  requests: { host: string; method: string; params: URLSearchParams }[] = [];
  failure: number | null = null;
  partial = false;
  downloadHost = "c1.pcloud.com";
  onDownload?: () => void;
  private serial = 10;
  private readonly folderIds = new Map([["", 1]]);
  private readonly emptyFolders = new Set<string>();
  set(path: string, text: string) {
    this.files.set(path, {
      text,
      fileid: this.files.get(path)?.fileid ?? ++this.serial,
      hash: `1844674407370955${String(++this.serial).padStart(4, "0")}`,
    });
  }
  setBytes(path: string, bytes: Uint8Array<ArrayBuffer>) {
    this.set(path, "");
    this.files.get(path)!.bytes = bytes;
  }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const form =
      url.pathname === "/uploadfile" ? (init?.body as FormData) : undefined;
    const params = new URLSearchParams();
    if (form) {
      form.forEach((value, key) => {
        if (typeof value === "string") params.append(key, value);
      });
    } else {
      new URLSearchParams(String(init?.body ?? "")).forEach((value, key) =>
        params.append(key, value),
      );
    }
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
      const body = file?.bytes ?? file?.text;
      this.onDownload?.();
      return new Response(body, { status: file ? 200 : 404 });
    }
    if (url.pathname === "/getfilelink")
      return Response.json({
        result: 0,
        hosts: [this.downloadHost],
        path: `/${params.get("fileid")}`,
      });
    if (params.has("nofiles"))
      throw new Error("nofiles is a presence flag and would hide all notes");
    if (url.pathname === "/deletefile") {
      const entry = [...this.files].find(
        ([, file]) => file.fileid === Number(params.get("fileid")),
      );
      if (!entry) return Response.json({ result: 2009 });
      this.files.delete(entry[0]);
      return Response.json({ result: 0 });
    }
    const folders = [
      "",
      ...new Set([
        ...this.emptyFolders,
        ...[...this.files.keys()].flatMap((p) =>
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
      ]),
    ];
    const folderId = (p: string) => {
      if (!this.folderIds.has(p))
        this.folderIds.set(p, this.folderIds.size + 100);
      return this.folderIds.get(p)!;
    };
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
            size: f.bytes?.length ?? new TextEncoder().encode(f.text).length,
            hash: f.hash,
            modified: "Mon, 02 Nov 2026 00:00:00 +0000",
          })),
      ],
    });
    const prefix = folders.find(
      (p) => folderId(p) === Number(params.get("folderid")),
    );
    if (prefix === undefined) return Response.json({ result: 2002 });
    if (url.pathname === "/createfolderifnotexists") {
      const name = params.get("name")!;
      const child = prefix ? `${prefix}/${name}` : name;
      if (!folders.includes(child)) folders.push(child);
      this.emptyFolders.add(child);
      return Response.json({
        result: 0,
        metadata: {
          name,
          folderid: folderId(child),
          parentfolderid: folderId(prefix),
          isfolder: true,
        },
      });
    }
    if (url.pathname === "/uploadfile") {
      const file = form?.get("file");
      if (!file || typeof file === "string" || !params.has("nopartial"))
        throw new Error("Invalid upload");
      const path = prefix ? `${prefix}/${file.name}` : file.name;
      if (/\.(md|markdown)$/i.test(path)) this.set(path, await file.text());
      else this.setBytes(path, new Uint8Array(await file.arrayBuffer()));
      return Response.json({ result: 0 });
    }
    if (url.pathname !== "/listfolder")
      throw new Error("Unexpected API mutation");
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
