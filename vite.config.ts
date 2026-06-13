import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  // Pre-bundle the client deps up front so adding a component that imports one
  // of them later doesn't trigger a mid-session re-optimize, which is what
  // 504'd ("Outdated Optimize Dep") an already-open tab. This is Vite's
  // documented way to keep the dep optimizer stable.
  optimizeDeps: {
    include: [
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
      "zod",
    ],
  },
});
