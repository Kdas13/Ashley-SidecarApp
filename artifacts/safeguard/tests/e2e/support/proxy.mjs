// Minimal HTTP reverse proxy used only by the e2e webServer config.
// Routes `/safeguard-api/*` to the API server and everything else to the
// Vite dev server, so the browser sees a single origin (matching how
// Replit's shared proxy fronts both services in dev/prod).
import http from "node:http";

const [, , portArg, webPortArg, apiPortArg] = process.argv;
const PORT = Number(portArg);
const WEB_PORT = Number(webPortArg);
const API_PORT = Number(apiPortArg);

if (!PORT || !WEB_PORT || !API_PORT) {
  console.error("usage: node proxy.mjs <listen-port> <web-port> <api-port>");
  process.exit(2);
}

function pickTarget(url) {
  if (url.startsWith("/safeguard-api")) return API_PORT;
  return WEB_PORT;
}

const server = http.createServer((req, res) => {
  const targetPort = pickTarget(req.url ?? "/");
  const proxyReq = http.request(
    {
      host: "127.0.0.1",
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy error: ${err.message}`);
  });
  req.pipe(proxyReq);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[e2e-proxy] listening on ${PORT}, web→${WEB_PORT}, api→${API_PORT}`,
  );
});
