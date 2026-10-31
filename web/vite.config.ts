import { readdirSync, readFileSync, statSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

function walk(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name === "build" || name === "__pycache__" || name.endsWith(".pyc")) continue;
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) Object.assign(out, walk(full, rel));
    else out[rel] = readFileSync(full, "utf8");
  }
  return out;
}

function projectFiles(): Plugin {
  const id = "virtual:project-files";
  const resolved = "\0" + id;
  return {
    name: "project-files",
    resolveId(source) {
      if (source === id) return resolved;
    },
    load(source) {
      if (source !== resolved) return;
      const toolchain = walk(path.join(publicDir, "toolchain", "esp-idf"));
      const examples = walk(path.join(publicDir, "examples"));
      const bootloader = walk(path.join(publicDir, "toolchain", "bootloader"));
      return `export const toolchain = ${JSON.stringify(toolchain)};\nexport const examples = ${JSON.stringify(examples)};\nexport const bootloader = ${JSON.stringify(bootloader)};\n`;
    },
  };
}

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
  plugins: [projectFiles(), copyWasmerSdk()],
  optimizeDeps: { exclude: ["@wasmer/sdk"] },
  build: {
    rollupOptions: {
      external: ["@wasmer/sdk"],
    },
  },
  server: { headers: isolation },
  preview: { headers: isolation },
});
