import { mount } from "svelte";

import Catalog from "./Catalog.svelte";

const target = document.querySelector<HTMLElement>("#app");

if (!target) throw new Error("Spark UI catalog root is missing");

mount(Catalog, { target });
