import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { colIndex, colName, excelDate, officeKind, parseDocx, parsePptx, parseXlsx, parseXml, resolvePart, textOf, unzipOffice } from "@/lib/office-preview";

const pkg = (parts: Record<string, string>) => unzipOffice(zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)]))));
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="r"';

describe("parseXml", () => {
  it("reads elements, attributes without prefixes, entities and CDATA", () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><a:x b:k="1 &amp; 2" q=\'>\'><a:t>A &lt;b&gt; &#x4e2d;</a:t><y/><![CDATA[<raw>]]></a:x>');
    const x = root.children[0] as any;
    expect(x.name).toBe("x");
    expect(x.attrs).toEqual({ k: "1 & 2", q: ">" });
    expect(textOf(x)).toBe("A <b> 中<raw>");
  });
  it("resolves relationship targets", () => {
    expect(resolvePart("ppt/slides/slide1.xml", "../media/image1.png")).toBe("ppt/media/image1.png");
    expect(resolvePart("word/document.xml", "media/a.png")).toBe("word/media/a.png");
    expect(resolvePart("xl/workbook.xml", "/xl/worksheets/sheet1.xml")).toBe("xl/worksheets/sheet1.xml");
  });
});

describe("docx", () => {
  it("reads headings, runs, numbered lists, tables and pictures", () => {
    const files = pkg({
      "word/document.xml": `<w:document ${W}><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>报告</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">粗 </w:t></w:r><w:hyperlink r:id="rLink"><w:r><w:t>链接</w:t></w:r></w:hyperlink></w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>一</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>二</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:p><w:r><w:drawing><wp:inline xmlns:wp="wp"><wp:extent cx="952500" cy="476250"/><a:blip xmlns:a="a" r:embed="rImg"/></wp:inline></w:drawing></w:r></w:p>
      </w:body></w:document>`,
      "word/_rels/document.xml.rels": `<Relationships><Relationship Id="rImg" Type="x/image" Target="media/image1.png"/><Relationship Id="rLink" Type="x/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>`,
      "word/styles.xml": `<w:styles ${W}><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
      "word/numbering.xml": `<w:numbering ${W}><w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num></w:numbering>`,
    });
    const { blocks } = parseDocx(files);
    expect(blocks[0]).toMatchObject({ kind: "p", heading: 1, runs: [{ text: "报告" }] });
    expect(blocks[1]).toMatchObject({ kind: "p", runs: [{ text: "粗 ", bold: true }, { text: "链接", href: "https://example.com" }] });
    expect(blocks[2]).toMatchObject({ list: { level: 0, ordered: true, number: 1 } });
    expect(blocks[3]).toMatchObject({ list: { number: 2 } });
    expect(blocks[4]).toMatchObject({ kind: "table" });
    expect((blocks[4] as any).rows[0][1][0].runs[0].text).toBe("B1");
    expect(blocks[5]).toEqual({ kind: "image", part: "word/media/image1.png", width: 100, height: 50 });
  });
  it("says what's wrong with a file that isn't one", () => {
    expect(() => parseDocx(pkg({ "x.xml": "<x/>" }))).toThrow(/Word/);
  });
});

describe("xlsx", () => {
  it("reads sheets with shared strings, inline strings, booleans and dates", () => {
    const files = pkg({
      "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="空" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>名称</t></si><si><r><t>富</t></r><r><t>文本</t></r></si></sst>`,
      "xl/styles.xml": `<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
        <row r="3"><c r="A3"><v>42.5</v></c><c r="B3" t="b"><v>1</v></c><c r="C3" s="1"><v>45000</v></c><c r="D3" t="inlineStr"><is><t>内联</t></is></c></row>
      </sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet><sheetData/></worksheet>`,
    });
    const { sheets } = parseXlsx(files);
    expect(sheets.map((s) => s.name)).toEqual(["数据", "空"]);
    expect(sheets[0].rows).toEqual([
      ["名称", "", "富文本", ""],
      ["", "", "", ""],
      ["42.5", "TRUE", "2023-03-15", "内联"],
    ]);
    expect(sheets[1].rows).toEqual([]);
  });
  it("converts column letters and serial dates", () => {
    expect(colIndex("A1")).toBe(0);
    expect(colIndex("AA10")).toBe(26);
    expect(colName(0)).toBe("A");
    expect(colName(27)).toBe("AB");
    expect(excelDate(45000.5)).toBe("2023-03-15 12:00");
  });
});

describe("pptx", () => {
  it("places shapes on the slide, takes a placeholder's box from its layout, reads pictures, tables and notes", () => {
    const P = 'xmlns:p="p" xmlns:a="a" xmlns:r="r"';
    const files = pkg({
      "ppt/presentation.xml": `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>`,
      "ppt/slides/slide1.xml": `<p:sld ${P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:bgPr></p:bg><p:spTree>
        <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:rPr sz="4000" b="1"/><a:t>标题</a:t></a:r></a:p></p:txBody></p:sp>
        <p:sp><p:spPr><a:xfrm><a:off x="1219200" y="3429000"/><a:ext cx="6096000" cy="1714500"/></a:xfrm></p:spPr><p:txBody><a:p><a:pPr lvl="1"><a:buChar char="•"/></a:pPr><a:r><a:t>要点</a:t></a:r></a:p></p:txBody></p:sp>
        <p:pic><p:blipFill><a:blip r:embed="rImg"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm></p:spPr></p:pic>
        <p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>格</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
      </p:spTree></p:cSld></p:sld>`,
      "ppt/slides/_rels/slide1.xml.rels": `<Relationships><Relationship Id="rL" Type="x/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rImg" Type="x/image" Target="../media/image1.png"/><Relationship Id="rN" Type="x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
      "ppt/slideLayouts/slideLayout1.xml": `<p:sldLayout ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="342900"/><a:ext cx="10972800" cy="1143000"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`,
      "ppt/notesSlides/notesSlide1.xml": `<p:notes ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>讲稿</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    });
    const deck = parsePptx(files);
    expect(deck.width).toBe(960);
    expect(deck.height).toBe(540);
    const [s] = deck.slides;
    expect(s.background).toBe("#112233");
    expect(s.notes).toBe("讲稿");
    expect(s.shapes[0]).toMatchObject({ kind: "text", title: true, box: { x: 0.05, y: 0.05 }, paragraphs: [{ runs: [{ text: "标题", size: 40, bold: true }] }] });
    expect(s.shapes[1]).toMatchObject({ kind: "text", title: false, box: { x: 0.1, y: 0.5, w: 0.5, h: 0.25 }, paragraphs: [{ level: 1, bullet: true }] });
    expect(s.shapes[2]).toMatchObject({ kind: "image", part: "ppt/media/image1.png", box: { w: 0.1, h: 0.1 } });
    expect(s.shapes[3]).toMatchObject({ kind: "table", rows: [["格"]] });
  });
  it("knows which formats it reads", () => {
    expect(officeKind("DOCX")).toBe("docx");
    expect(officeKind("potx")).toBe("pptx");
    expect(officeKind("xlsx")).toBe("xlsx");
    expect(officeKind("doc")).toBeNull();
    expect(officeKind("key")).toBeNull();
  });
});
