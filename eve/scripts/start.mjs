#!/usr/bin/env node

import { launchEveRuntime } from "./runtime-launcher.mjs";

await launchEveRuntime({ mode: "production" });
