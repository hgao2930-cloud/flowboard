export const MAX_IMPORT_BYTES: number;
export interface BoardFile {
  format: "flowboard";
  version: 1;
  title: string;
  nodes: {
    id: string;
    position: { x: number; y: number };
    data: {
      label: string;
      content: string;
      color: "mint" | "blue" | "violet" | "amber" | "rose";
    };
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }[];
}
export function readBoardFile(value: unknown): BoardFile;
