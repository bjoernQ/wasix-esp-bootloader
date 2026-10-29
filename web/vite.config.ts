import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

function copyWasmerSdk(): Plugin {
  return {
    name: "copy-wasmer-sdk",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (ctx.server || html.includes("importmap")) return html;
        const map = `<script type="importmap">{"imports":{"@wasmer/sdk":"./vendor/wasmer/dist/index.js"}}</script>`;
        return html.replace("<head>", `<head>\n    ${map}`);
      },
    },
    closeBundle() {
      const from = path.join(root, "node_modules", "@wasmer", "sdk");
      const to = path.join(root, "dist", "vendor", "wasmer");
      cpSync(path.join(from, "dist"), path.join(to, "dist"), { recursive: true });
      cpSync(path.join(from, "pkg"), path.join(to, "pkg"), { recursive: true });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [copyWasmerSdk()],
  optimizeDeps: { exclude: ["@wasmer/sdk"] },
  build: {
    rollupOptions: {
      external: ["@wasmer/sdk"],
    },
  },
  server: { headers: isolation },
  preview: { headers: isolation },
});
