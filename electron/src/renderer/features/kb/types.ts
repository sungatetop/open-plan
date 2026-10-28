/**
 * kb 前端域内共享数据视图（F5-8）：字段契约 = server/kb.mjs / backend/kb.ts 域函数，
 * 与 channels.ts 宽松响应类型（Kb*Response）在组件边界经本文件收窄。
 */
import type { KbRootMeta } from "../../../shared/protocol/channels";

export type { KbRootMeta };

/** 目录树一级项（getTreeLevel）：旧组件消费字段。 */
export interface KbDirItem { type?: string; name: string; path?: string; subCount?: number }
export interface KbFileItem { type?: string; name: string; relPath: string; title?: string; tags?: string[]; linkCount?: number; mtime?: number }
export interface KbTreeLevel { dirs?: KbDirItem[]; files?: KbFileItem[] }

/** 知识库文档（getDoc）：KnowledgeBase/MindMap 消费字段。 */
export interface KbDoc {
  title?: string;
  relPath: string;
  rootIdx?: number;
  rootName?: string;
  content?: string;
  tags?: string[];
  headings?: string[];
  links?: Array<{ relPath?: string; rootIdx?: number; alias?: string; title?: string }>;
  backlinks?: Array<{ relPath?: string; rootIdx?: number; title?: string; snippet?: string }>;
  mentions?: Array<{ relPath?: string; rootIdx?: number; title?: string; snippet?: string }>;
  [key: string]: unknown;
}

/** IMA 云端知识库清单项（imaListBases）。 */
export interface ImaBase { id?: unknown; name?: string }

/** IMA 检索结果项（imaSearch）。 */
export interface ImaResultItem { media_id?: string; title?: string; snippet?: string }

/** IMA 文档视图（imaDoc）。 */
export interface ImaDocView { title?: string; content?: string; url?: string }

/** 本地检索结果项（search）。 */
export interface KbSearchResult { relPath: string; title?: string; snippet?: string; tags?: string[] }

/**
 * MindMap 全量树项（getTree 形状）。
 * 留档：/api/kb/tree 路由（server/index.mjs L376-381）自 getTreeLevel 接管后已无 tree
 * 字段，MindMap 旧组件的 `t?.tree` 分支为既有死路径（大纲恒空、G6 不实例化），本次
 * 迁移忠实保留该形态、不改行为（R5 口径：保持功能不变，死路径修复随上游决策）。
 */
export interface KbTreeItem { type?: string; name: string; relPath?: string; title?: string; children?: KbTreeItem[]; rootIdx?: number }
