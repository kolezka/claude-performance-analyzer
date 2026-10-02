// tsc has no .svelte parser; this lets it resolve `import X from "./X.svelte"` without
// type-checking the component internals. Component internals are checked by the Svelte
// compiler at build time (type errors inside .svelte script blocks are not caught by `tsc`).
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<any>;
  export default component;
}
