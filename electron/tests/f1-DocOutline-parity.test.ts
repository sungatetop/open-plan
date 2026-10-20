import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { extractDocxOutline } from "../src/renderer/lib/DocOutline";

const clientModule = await import("../../client/src/components/DocOutline.js");
const client = clientModule as unknown as { extractDocxOutline: typeof extractDocxOutline };

const STYLES_XML = `<?xml version="1.0"?><w:styles xmlns:w="http://x">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="CnTitle"><w:name w:val="标题 2"/></w:style>
<w:style w:type="paragraph" w:styleId="T1"><w:outlineLvl w:val="2"/><w:name w:val="自定义"/></w:style>
<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="NoNum"><w:name w:val="heading"/></w:style>
<w:style w:type="paragraph" w:styleId="Big"><w:name w:val="heading 12"/></w:style>
<w:style w:type="paragraph" w:styleId="Trad"><w:name w:val="標題 3"/></w:style>
</w:styles>`;

const DOC_XML = `<?xml version="1.0"?><w:document xmlns:w="http://x">
<w:p><w:pPr><w:outlineLvl w:val="8"/></w:pPr><w:r><w:t>正文前的段落不应被算入</w:t></w:r></w:p>
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目背景</w:t></w:r></w:p>
<w:p><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:r><w:t>直接大纲层级</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="T1"/></w:pPr><w:r><w:t>样式 outline 优先于名称</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="CnTitle"/></w:pPr><w:r><w:t>中文样式名</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Trad"/></w:pPr><w:r><w:t>繁体样式名</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Big"/></w:pPr><w:r><w:t>超界层级收敛</w:t></w:r></w:p>
<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>A &amp;amp; B &amp;lt; 中&#x4E2D;&#65;文 "引号"</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${"长".repeat(200)}</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr><w:r><w:t>正文不算标题</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="NoNum"/></w:pPr><w:r><w:t>heading 无编号不算</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Ghost"/></w:pPr><w:r><w:t>未知样式不算</w:t></w:r></w:p>
<w:p><w:r><w:t>无样式无层级</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">  </w:t><w:t>空白与拼接  </w:t><w:t>成段</w:t></w:r></w:p>
<w:p><w:r><w:t>A &amp;amp; B &amp;lt; 中&#x4E2D;&#65;文 "引号"</w:t></w:r></w:p>
<w:p><w:r><w:t>${"长".repeat(200)}</w:t></w:r></w:p>
</w:body></w:document>`;

async function buildDocx(docXml: string, stylesXml?: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("word/document.xml", docXml);
  if (stylesXml !== undefined) zip.file("word/styles.xml", stylesXml);
  return zip.generateAsync({ type: "uint8array" });
}

describe("DocOutline TS 版与 client 版等价（对拍）", () => {
  it("正常 docx：段落层级、实体解码、文本截断、headingClasses 与 client 版逐字段一致", async () => {
    const data = await buildDocx(DOC_XML, STYLES_XML);
    const d = await extractDocxOutline(data);
    const s = await client.extractDocxOutline(data.slice());
    expect(d).toEqual(s);

    // 绝对锚点：正文前段落（outlineLvl=8）被排除；正文段（无层级/样式兜不住）全部跳过；
    // outlineLvl=0 的实体解码段与 200 字长段是合法标题，且文本截断到 160 字
    expect(d.items.map((i) => [i.level, i.text])).toEqual([
      [1, "项目背景"],
      [4, "直接大纲层级"],
      [3, "样式 outline 优先于名称"],
      [2, "中文样式名"],
      [3, "繁体样式名"],
      [6, "超界层级收敛"],
      [1, 'A &amp; B &lt; 中中A文 "引号"'],
      [1, "长".repeat(160)],
    ]);
    expect(d.headingClasses).toEqual([
      { className: "oaw-docx_Heading1", level: 1 },
      { className: "oaw-docx_T1", level: 3 },
      { className: "oaw-docx_CnTitle", level: 2 },
      { className: "oaw-docx_Trad", level: 3 },
      { className: "oaw-docx_Big", level: 6 },
    ]);
  });

  it("缺 styles.xml：仍按段落级 outline 提取，样式名路径不可用", async () => {
    const docOnly = `<?xml version="1.0"?><w:document><w:body>
<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>顶层</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>无样式表</w:t></w:r></w:p>
</w:body></w:document>`;
    const data = await buildDocx(docOnly);
    const d = await extractDocxOutline(data);
    const s = await client.extractDocxOutline(data.slice());
    expect(d).toEqual(s);
    expect(d.items).toEqual([{ level: 1, text: "顶层" }]);
    expect(d.headingClasses).toEqual([]);
  });

  it("缺 word/document.xml：返回空结果", async () => {
    const zip = new JSZip();
    zip.file("word/styles.xml", STYLES_XML);
    const data = await zip.generateAsync({ type: "uint8array" });
    const d = await extractDocxOutline(data);
    const s = await client.extractDocxOutline(data.slice());
    expect(d).toEqual(s);
    expect(d).toEqual({ items: [], headingClasses: [] });
  });

  it("坏数据/空数据：异常被吞，返回空结果", async () => {
    for (const bad of [new Uint8Array([1, 2, 3, 4]), new Uint8Array(0), new ArrayBuffer(0), "not-a-zip" as unknown as ArrayBuffer]) {
      const d = await extractDocxOutline(bad);
      const s = await client.extractDocxOutline(bad as any);
      expect(d).toEqual(s);
      expect(d).toEqual({ items: [], headingClasses: [] });
    }
  });

  it("无 w:body 包裹：退回全文匹配，仍可提取段落", async () => {
    const noBody = `<?xml version="1.0"?><w:document>
<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>无 body 也能提取</w:t></w:r></w:p>
</w:document>`;
    const data = await buildDocx(noBody);
    const d = await extractDocxOutline(data);
    const s = await client.extractDocxOutline(data.slice());
    expect(d).toEqual(s);
    expect(d.items).toEqual([{ level: 2, text: "无 body 也能提取" }]);
  });
});
