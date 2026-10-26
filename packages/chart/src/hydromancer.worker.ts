// Runs the Hydromancer client off the main thread. Started by App.svelte.

import { serveHydromancer } from '@local/hydromancer'

serveHydromancer(self)
