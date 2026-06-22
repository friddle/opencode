import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
          "import.meta.env.BASE_URL": "__OPENCODE_BASE__",
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode:web-base-preload",
    enforce: "post",
    closeBundle() {
      const assetsDir = fileURLToPath(new URL("./dist/assets", import.meta.url))
      for (const file of readdirSync(assetsDir)) {
        if (!file.endsWith(".js")) continue
        const filepath = `${assetsDir}/${file}`
        const code = readFileSync(filepath, "utf8")
        const replaced = code.replace(
          /=function\(([a-zA-Z])\)\{return"\/"\+\1\}/g,
          '=function($1){return(__OPENCODE_BASE__||"/")+$1}',
        )
        if (replaced !== code) {
          writeFileSync(filepath, replaced)
          console.log(`  patched base resolver in ${file}`)
        }
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  tailwindcss(),
  solidPlugin(),
]
