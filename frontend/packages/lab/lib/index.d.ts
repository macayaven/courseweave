/**
 * CourseWeave JupyterLab bridge.
 *
 * A prebuilt JupyterLab 4 extension with no React. It opens exactly one
 * sandboxed iframe hosting the CourseWeave guide rail served by the local
 * loopback CourseWeave service, opens allowlisted course surfaces through
 * native Jupyter APIs, and ignores untrusted child messages (design spec §12).
 */
import { JupyterFrontEndPlugin } from '@jupyterlab/application';
declare const plugin: JupyterFrontEndPlugin<void>;
export default plugin;
