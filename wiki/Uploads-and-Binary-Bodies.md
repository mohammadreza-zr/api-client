# Uploads and Binary Bodies

## Supported body types

These are detected and passed to `fetch` **untouched** — never `JSON.stringify`ed:

| Type | Content-Type sent |
|---|---|
| `FormData` | `multipart/form-data; boundary=…` (runtime-generated) |
| `File` / `Blob` | The blob's own `type` |
| `ArrayBuffer` | Let the runtime decide (usually none) |
| Typed arrays — `Uint8Array`, `DataView`, `Int32Array`, … | Let the runtime decide |
| `URLSearchParams` | `application/x-www-form-urlencoded;charset=UTF-8` |
| `ReadableStream` | Let the runtime decide (`duplex: "half"` set automatically) |
| `string` | `application/json` (kept — a pre-serialized JSON string is a common payload) |
| anything else | `application/json`, after `JSON.stringify` |

> Typed arrays are caught via `ArrayBuffer.isView()`. Without that check a `Uint8Array` would fall through to `JSON.stringify` and be transmitted as `{"0":72,"1":105}` instead of raw bytes. The repo's `verify/audit.mjs` asserts the byte-for-byte round trip.

---

## Content-Type resolution

The client applies `Content-Type: application/json` by default. For self-describing bodies that default would be a lie, so it is dropped. The precedence:

1. **A per-request header always wins.**
   ```ts
   await api.post("/upload", pngBytes, { headers: { "Content-Type": "image/png" } });
   ```
2. **A non-JSON client-wide header counts as deliberate** and is kept.
   ```ts
   createClient({ headers: { "Content-Type": "application/xml" } });
   ```
3. **Otherwise, self-describing bodies drop the header** so the runtime sets the right one.
4. **`FormData` always drops it** unless your explicit value contains `boundary=` — a hand-written multipart header without a boundary corrupts the request, so the client removes it rather than let the upload fail mysteriously.

Header lookup is case-insensitive throughout: `content-type`, `Content-Type` and `CONTENT-TYPE` are the same key.

---

## Examples

### FormData

```ts
const form = new FormData();
form.append("file", fileInput.files[0]);
form.append("title", "Holiday photo");

await api.post("/upload", form);
// Content-Type: multipart/form-data; boundary=----WebKitFormBoundary...
```

Filenames and binary content are preserved exactly.

### File / Blob

```ts
await api.put("/avatar", file);
// Content-Type: image/png (from the File itself)

await api.post("/upload", new Blob([bytes], { type: "application/octet-stream" }));
// Content-Type: application/octet-stream
```

### Raw bytes

```ts
const bytes = new Uint8Array([0x48, 0x69]);
await api.post("/raw", bytes, { headers: { "Content-Type": "application/octet-stream" } });
// exactly 2 bytes on the wire
```

### Form-urlencoded

```ts
await api.post("/token", new URLSearchParams({
  grant_type: "password",
  username: "ada",
  password: "secret",
}));
// Content-Type: application/x-www-form-urlencoded;charset=UTF-8
```

### Streaming

```ts
await api.post("/upload", file.stream(), { worker: false } as never);
```

`duplex: "half"` is set automatically — omitting it makes `fetch` reject with *"duplex option is required when sending a body"*. See the caveats below.

---

## Timeouts on uploads

The default 30 s timeout applies **per attempt** and will abort a slow upload. Disable it:

```ts
await api.post("/upload", form, { timeout: 0 });
```

---

## Long uploads and token expiry

A five-minute upload can outlive its access token. The client already handles a mid-flight 401 by refreshing and re-sending the body — but re-uploading a large file is wasteful, and a `ReadableStream` cannot be replayed at all.

### `uploadSkewMs` — refresh *before* you start

```ts
await api.post("/upload", form, {
  uploadSkewMs: 10 * 60_000, // "this may run 10 minutes — refresh now if needed"
  timeout: 0,
});
```

It refreshes **only** when the token actually falls inside the window, so short uploads pay nothing. And because it is a per-request signal, it works even when the client-wide `refreshSkewMs` is `0`.

Rule of thumb: `uploadSkewMs ≈ file size ÷ expected upload speed`, plus a margin.

```ts
const estimatedMs = (file.size / (500 * 1024)) * 1000; // assume 500 KB/s
await api.post("/upload", form, {
  uploadSkewMs: estimatedMs * 1.5,
  timeout: 0,
});
```

### What happens if the token dies anyway

| Body type | On a mid-upload 401 |
|---|---|
| `FormData`, `File`, `Blob`, `ArrayBuffer`, typed array, `string` | Token refreshed, body re-sent intact, transparent to you |
| `ReadableStream` | Cannot be replayed — you get a clear failure, and the token *has* been refreshed, so simply retrying succeeds |

The stream failure message is explicit rather than fetch's opaque *"body object should not be disturbed or locked"*:

> Access token expired during a streamed upload and the stream cannot be replayed. The token has been refreshed — retry the upload, or pass `uploadSkewMs` to refresh before starting.

```ts
const res = await api.post("/upload", stream, { throwError: false });
if (res.statusCode === 401) {
  await api.post("/upload", makeFreshStream()); // token is already valid
}
```

---

## Streams and Web Workers

A `ReadableStream` **cannot be structured-cloned** into a Web Worker. Rather than let `postMessage` throw an opaque `DataCloneError`, the client detects it and fails with an actionable message:

> A ReadableStream body cannot be sent through a Web Worker. Create this client with `worker: false`, or send a Blob/File/FormData instead.

Options, in order of preference:

```ts
// 1. Send a Blob or File instead — works in worker mode
await api.post("/upload", file);

// 2. A dedicated non-worker client for streaming
const streamApi = createClient({ baseUrl, worker: false });
await streamApi.post("/upload", stream);

// 3. Turn the worker off entirely
const api = createClient({ baseUrl, worker: false });
```

`FormData`, `File`, `Blob`, `ArrayBuffer` and typed arrays are all transferable and work fine in worker mode.

---

## Tracking upload progress

The `fetch` standard has no upload-progress event, so neither does this client — no library built on `fetch` can offer one without a stream trick. Two options:

**1. Wrap the body in a counting `ReadableStream`** (requires `worker: false` and an HTTP/2 endpoint):

```ts
function withProgress(blob: Blob, onProgress: (sent: number) => void) {
  const reader = blob.stream().getReader();
  let sent = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      sent += value.byteLength;
      onProgress(sent);
      controller.enqueue(value);
    },
  });
}

const api = createClient({ baseUrl, worker: false });
await api.post("/upload", withProgress(file, (n) => setPct(n / file.size)), {
  headers: { "Content-Type": file.type },
  timeout: 0,
  uploadSkewMs: 600_000,
});
```

**2. Use `XMLHttpRequest` for the upload only**, and this client for everything else. `xhr.upload.onprogress` is still the only universally supported progress API.

---

## Chunked / resumable uploads

For very large files, chunk them yourself — each chunk is a normal request and gets its own refresh handling:

```ts
const CHUNK = 5 * 1024 * 1024;

for (let i = 0; i * CHUNK < file.size; i++) {
  const chunk = file.slice(i * CHUNK, (i + 1) * CHUNK);
  await api.post("/upload/chunk", chunk, {
    params: { uploadId, index: i },
    headers: { "Content-Type": "application/octet-stream" },
    timeout: 0,
  });
  setProgress((i + 1) * CHUNK / file.size);
}

await api.post("/upload/complete", { uploadId });
```

This gives you progress, retries and resumability for free, and each chunk stays inside a normal timeout budget.

Next: **[[Authentication]]**
