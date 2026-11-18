declare class MarkdownIt { constructor(options?: {html?: boolean}); parse(text: string, env: object): {type: string; level: number; map: [number,number] | null}[]; }
export = MarkdownIt;
