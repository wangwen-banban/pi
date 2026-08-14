import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { describe, it } from "node:test";

import { createRoutedHttpTransport } from "./transport.ts";

function missingUndici() {
  throw Object.assign(new Error("Cannot find module 'undici'"), { code: "MODULE_NOT_FOUND" });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("provider-routing module and transport portability", () => {
  it("loads through pi virtual modules without fixed npm/nvm paths", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(source, /from "@earendil-works\/pi-ai"/);
    assert.doesNotMatch(source, /PI_ROOT|PI_AI_COMPAT|\/Users\/[^/]+\/\.nvm/);
    assert.doesNotMatch(source, /node_modules\/@earendil-works\/pi-ai\/dist/);

    const result = spawnSync(
      "pi",
      [
        "--provider",
        "openai-codex-second",
        "--model",
        "gpt-5.6-sol",
        "--no-session",
        "-p",
        "Reply exactly PROVIDER-ROUTING-LOAD-OK",
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.notEqual(result.error?.code, "ENOENT", "pi executable must be available");
    assert.doesNotMatch(output, /Failed to load extension|Cannot find module/);
    assert.ok(
      output.includes("PROVIDER-ROUTING-LOAD-OK") ||
        output.includes("No API key found for openai-codex-second"),
      `provider routing did not load correctly:\n${output.slice(0, 500)}`,
    );
  });

  it("uses CONNECT for HTTPS routes such as openai-codex on the Node fallback", async (t) => {
    let authority;
    const proxy = http.createServer();
    proxy.on("connect", (request, socket) => {
      authority = request.url;
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    const proxyPort = await listen(proxy);
    const transport = createRoutedHttpTransport({ loadUndici: missingUndici });
    t.after(async () => {
      await transport.close();
      await close(proxy);
    });

    await assert.rejects(
      transport.fetch("https://api.openai.com/v1/responses", {}, {
        proxyUrl: `http://127.0.0.1:${proxyPort}`,
      }),
      /Proxy CONNECT failed with status 502/,
    );
    assert.equal(authority, "api.openai.com:443");
  });

  it("keeps direct and explicit HTTP-proxy streaming routes working on the Node fallback", async (t) => {
    let proxyHits = 0;
    const target = http.createServer((request, response) => {
      let requestBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { requestBody += chunk; });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        setImmediate(() => response.end(`data: ${requestBody}\n\n`));
      });
    });
    const targetPort = await listen(target);

    const proxy = http.createServer((request, response) => {
      proxyHits += 1;
      const targetUrl = new URL(request.url);
      const upstream = http.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        method: request.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers: { ...request.headers, host: targetUrl.host },
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", (error) => response.destroy(error));
      request.pipe(upstream);
    });
    const proxyPort = await listen(proxy);

    const transport = createRoutedHttpTransport({ loadUndici: missingUndici });
    t.after(async () => {
      await transport.close();
      await close(proxy);
      await close(target);
    });

    assert.equal(transport.backend, "node");
    const direct = await transport.fetch(`http://127.0.0.1:${targetPort}/messages`, {
      method: "POST",
      body: "direct",
    });
    assert.equal(direct.status, 200);
    assert.equal(await direct.text(), "data: first\n\ndata: direct\n\n");
    assert.equal(proxyHits, 0);

    const proxied = await transport.fetch(`http://127.0.0.1:${targetPort}/responses`, {
      method: "POST",
      body: "proxied",
    }, {
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
    });
    assert.equal(proxied.status, 200);
    const decoder = new TextDecoder();
    let streamed = "";
    for await (const chunk of proxied.body) streamed += decoder.decode(chunk, { stream: true });
    streamed += decoder.decode();
    assert.equal(streamed, "data: first\n\ndata: proxied\n\n");
    assert.equal(proxyHits, 1);
  });
});
