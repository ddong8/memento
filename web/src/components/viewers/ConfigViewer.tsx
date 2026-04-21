"use client";

import { useEffect, useRef } from "react";
import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import sql from "highlight.js/lib/languages/sql";
import ini from "highlight.js/lib/languages/ini";
import "highlight.js/styles/github-dark.min.css";

hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("toml", ini);

const LANG_MAP: Record<string, string> = {
  jsonl: "json", toml: "ini", text: "plaintext", markdown: "plaintext",
};

export default function ConfigViewer({ content, language }: { content: string; language?: string }) {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.removeAttribute("data-highlighted");
      hljs.highlightElement(codeRef.current);
    }
  }, [content, language]);

  const lang = LANG_MAP[language || ""] || language || "plaintext";

  return (
    <div className="rounded-lg overflow-x-auto shadow-md">
      <pre className="text-sm font-mono p-4 m-0 bg-[#1e1e1e] text-gray-100">
        <code ref={codeRef} className={`language-${lang} hljs`}>
          {content}
        </code>
      </pre>
    </div>
  );
}
