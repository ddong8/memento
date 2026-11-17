"""Scenario memories are stored as JSON for mind resonance; MEMORY.md and the memory page showed
that JSON as is (2026-11-17). They read as a sentence now."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.services.dreaming_service import readable_memory  # noqa: E402


def test_a_scenario_reads_as_a_sentence():
    raw = json.dumps({
        "id": "chem_eval", "name": "化学结构式识别模型评测", "mindset": "选型拿量化指标说话。",
        "keywords": ["COMO", "DECIMER"], "target_project": "chemagent",
        "defense_rules": ["1) 上线前在同一测试集对比。", "2) 保留评测结果文件。"], "device_affinity": None,
    }, ensure_ascii=False)
    text = readable_memory(raw)
    assert text == (
        "化学结构式识别模型评测：选型拿量化指标说话；项目：chemagent；关键词：COMO、DECIMER；"
        "防线：1) 上线前在同一测试集对比；2) 保留评测结果文件。"
    )
    assert "{" not in text


def test_other_memories_are_left_as_they_are():
    assert readable_memory("回复用中文") == "回复用中文"
    assert readable_memory('{"a": 1}') == '{"a": 1}'
    assert readable_memory("{not json") == "{not json"
    assert readable_memory(None) == ""
