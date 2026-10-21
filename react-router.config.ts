import type { Config } from "@react-router/dev/config";

export default {
  // A browser-only app. The Rust server in server/ serves the built files and
  // answers every data request.
  ssr: false,
} satisfies Config;
