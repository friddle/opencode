import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { ProxyUtil } from "../proxy-util"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

export const csp = (...hashes: string[]) =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hashes.map((h) => ` 'sha256-${h}'`).join("")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src * data:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

function inlineScriptHashes(body: string) {
  const hashes: string[] = []
  const themeMatch = themePreloadHash(body)
  if (themeMatch) hashes.push(createHash("sha256").update(themeMatch[2]).digest("base64"))
  const baseMatch = body.match(/<script[^>]*>var __OPENCODE_BASE__[^<]*<\/script>/i)
  if (baseMatch) {
    const content = baseMatch[0].match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1]
    if (content) hashes.push(createHash("sha256").update(content).digest("base64"))
  }
  return hashes
}

export function cspForHtml(body: string) {
  return csp(...inlineScriptHashes(body))
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

export function webBase() {
  const base = process.env.OPENCODE_WEB_BASE
  if (!base) return ""
  return base.endsWith("/") ? base.slice(0, -1) : base
}

export function applyWebBase(html: string) {
  const base = webBase()
  const resolved = base ? base + "/" : "/"
  const script = base
    ? `<script>var __OPENCODE_BASE__=${JSON.stringify(resolved)};(function(){var B=${JSON.stringify(base)};var _p=history.pushState;history.pushState=function(){if(typeof arguments[2]==="string"&&arguments[2][0]==="/"&&arguments[2].indexOf(B)!==0)arguments[2]=B+arguments[2];return _p.apply(this,arguments)};var _r=history.replaceState;history.replaceState=function(){if(typeof arguments[2]==="string"&&arguments[2][0]==="/"&&arguments[2].indexOf(B)!==0)arguments[2]=B+arguments[2];return _r.apply(this,arguments)}})()</script>`
    : `<script>var __OPENCODE_BASE__=${JSON.stringify(resolved)}</script>`
  let result = html
  if (result.includes("<head>")) {
    result = result.replace("<head>", `<head>${script}`)
  } else {
    result = script + result
  }
  if (base) {
    result = result.replace(/((?:src|href)=["'])\//g, `$1${base}/`)
  }
  return result
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    const html = applyWebBase(new TextDecoder().decode(body))
    headers.set("content-security-policy", cspForHtml(html))
    return HttpServerResponse.text(html, { headers })
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: FSUtil.Interface; client: HttpClient.HttpClient; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI)

    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: ProxyUtil.headers(request.headers, { host: UI_UPSTREAM.host }),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = applyWebBase(yield* response.text)
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}
