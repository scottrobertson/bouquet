import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    // Safari holds on to the js it has already downloaded, even when the dev
    // server says not to. When the dep optimizer re-bundles, the file names it
    // hands out change, and Safari keeps asking for the old ones until you empty
    // its cache by hand. The page then loads half broken with 504s in the
    // console. Nothing here is worth caching, it's all coming from localhost.
    headers: { "Cache-Control": "no-store" },
    // In dev the Rust server runs alongside Vite and answers everything that
    // isn't a page.
    proxy: Object.fromEntries(
      ["/api", "/events", "/output", "/img", "/settings/backup"].map((path) => [
        path,
        { target: process.env.BOUQUET_API_URL ?? "http://localhost:3000" },
      ]),
    ),
  },
  // Pre-bundle the client deps up front so adding a component that imports one
  // of them later doesn't trigger a mid-session re-optimize, which is what
  // 504'd ("Outdated Optimize Dep") an already-open tab. This is Vite's
  // documented way to keep the dep optimizer stable.
  optimizeDeps: {
    include: [
      // The app only runs in the browser, so these are first seen while a page
      // loads rather than when the dev server starts. Left to be found then,
      // they get bundled mid-load and the page fails with "Outdated Optimize
      // Dep" errors.
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-router",
      "react-router/dom",
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
      "@tanstack/react-virtual",
      "radix-ui",
      "cmdk",
      "sonner",
      "lucide-react",
      "clsx",
      "tailwind-merge",
      "class-variance-authority",
    ],
  },
});
