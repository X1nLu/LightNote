/// <reference types="vite/client" />

declare module "markdown-it-katex";
declare module "*.css";
declare module "katex/dist/katex.min.css";
declare module "*?raw" {
	const content: string;
	export default content;
}