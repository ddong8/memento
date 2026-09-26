import 'dart:math' as math;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/theme/aurora_theme.dart';
import '../../models/device.dart';
import '../widgets/app_markdown.dart';
import '../widgets/aurora_shimmer.dart';
import '../widgets/glass_card.dart';

/// Tool id -> (label, instruction file the block goes into).
const personaTargetMeta = <String, (String, String)>{
  'claude_code': ('Claude Code', '~/.claude/CLAUDE.md'),
  'codex': ('Codex', '~/.codex/AGENTS.md'),
  'antigravity': ('Antigravity / Gemini', '~/.gemini/GEMINI.md'),
  'openclaw': ('OpenClaw', '~/.openclaw/workspace/USER.md'),
  'hermes': ('Hermes', '~/.hermes/SOUL.md'),
};

const _draftStatusMessages = <String, String>{
  'same_as_published': '和已发布的画像一致，没有新内容。',
  'no_input': '最近 30 天没有足够的输入来生成画像。',
  'llm_failed': '生成失败：AI 服务暂时不可用，稍后再试。',
  'no_llm': '服务端没有配置 AI 服务，无法生成草稿。你可以手动编辑后发布。',
  'user_editing': '你改过当前草稿。先发布或丢弃它，再重新生成。',
};

/// Bullet lines added to / removed from the published profile. Headings and
/// blank lines aren't meaningful changes, so only "- " lines are compared.
({List<String> added, List<String> removed}) personaLineDiff(String draft, String? published) {
  List<String> bullets(String? text) => (text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .where((l) => l.startsWith('- '))
      .toList();
  final before = bullets(published).toSet();
  final after = bullets(draft).toSet();
  return (
    added: after.where((l) => !before.contains(l)).toList(),
    removed: before.where((l) => !after.contains(l)).toList(),
  );
}

enum PersonaTargetState { pending, written, upToDate, skipped, waiting, error }

/// What to show on a device's tool toggle, or null for a tool that is off and clean.
PersonaTargetState? personaTargetState({
  required bool enabled,
  required String? result,
  required int? reportedVersion,
  required int? publishedVersion,
}) {
  if (result == null) return enabled ? PersonaTargetState.pending : null;
  if (result.startsWith('error')) return PersonaTargetState.error;
  if (result.startsWith('skipped')) return PersonaTargetState.skipped;
  if (result.startsWith('waiting')) return PersonaTargetState.waiting;
  if (result == 'removed') return enabled ? PersonaTargetState.pending : null;
  if (!enabled || reportedVersion != publishedVersion) return PersonaTargetState.pending;
  return result == 'written' ? PersonaTargetState.written : PersonaTargetState.upToDate;
}

class PersonaTab extends StatefulWidget {
  const PersonaTab({super.key});

  @override
  State<PersonaTab> createState() => _PersonaTabState();
}

class _PersonaTabState extends State<PersonaTab> with AutomaticKeepAliveClientMixin {
  final _api = ApiClient();
  Map<String, dynamic>? _state;
  String? _error;
  String? _notice;
  String? _busy; // regenerate | publish | save | discard
  String? _editing; // draft | published
  final _editor = TextEditingController();

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _editor.dispose();
    super.dispose();
  }

  Map<String, dynamic>? get _draft => _state?['draft'] as Map<String, dynamic>?;
  Map<String, dynamic>? get _published => _state?['published'] as Map<String, dynamic>?;

  Future<void> _load() async {
    try {
      final state = await _api.getProfile();
      if (!mounted) return;
      setState(() {
        _state = state;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = _describe(e));
    }
  }

  String _describe(Object e) {
    if (e is DioException) {
      final detail = e.response?.data is Map ? (e.response!.data as Map)['detail'] : null;
      return detail?.toString() ?? e.message ?? e.toString();
    }
    return e.toString();
  }

  Future<void> _run(String kind, Future<void> Function() action) async {
    setState(() {
      _busy = kind;
      _notice = null;
    });
    try {
      await action();
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = _describe(e));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  void _regenerate() => _run('regenerate', () async {
        final res = await _api.regenerateProfileDraft();
        final status = res['status']?.toString() ?? '';
        if (status != 'updated') _notice = _draftStatusMessages[status] ?? status;
      });

  void _startEditing(String which, String initial) {
    _editor.text = initial;
    setState(() => _editing = which);
  }

  void _saveDraft() => _run('save', () async {
        await _api.saveProfileDraft(_editor.text);
        _editing = null;
      });

  Future<void> _toggleTarget(Map<String, dynamic> device, String tool) async {
    final current = ((device['targets'] as List?) ?? const []).cast<String>();
    final next = current.contains(tool) ? current.where((t) => t != tool).toList() : [...current, tool];
    setState(() => device['targets'] = next); // optimistic
    try {
      await _api.setProfileTargets(device['device_id'].toString(), next);
    } catch (e) {
      if (mounted) setState(() => _error = _describe(e));
    }
    await _load();
  }

  static String _formatTime(String? iso) {
    if (iso == null) return '';
    final t = DateTime.tryParse(iso)?.toLocal();
    if (t == null) return '';
    String two(int n) => n.toString().padLeft(2, '0');
    return '${t.month}-${t.day} ${two(t.hour)}:${two(t.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    if (_state == null && _error == null) return const AuroraListSkeleton(count: 3, itemHeight: 120);

    return RefreshIndicator(
      onRefresh: _load,
      color: AuroraColors.accent,
      // A readable column on wide windows instead of spanning the whole page.
      child: LayoutBuilder(
        builder: (context, constraints) => ListView(
        padding: EdgeInsets.symmetric(
          horizontal: math.max(16, (constraints.maxWidth - 880) / 2),
          vertical: 16,
        ),
        children: [
          _buildIntro(),
          if (_error != null) _banner(_error!, AuroraColors.danger),
          if (_notice != null) _banner(_notice!, AuroraColors.fg2),
          const SizedBox(height: 12),
          _buildDraftCard(),
          const SizedBox(height: 12),
          _buildPublishedCard(),
          const SizedBox(height: 12),
          _buildDevicesCard(),
        ],
      ),
      ),
    );
  }

  Widget _buildIntro() {
    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.badge_outlined, color: AuroraColors.accent, size: 20),
              SizedBox(width: 8),
              Text('常驻画像', style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AuroraColors.fg1)),
            ],
          ),
          const SizedBox(height: 8),
          const Text(
            '每次打开 AI 工具时自动加载的「关于我」。每晚根据你亲口说的话生成草稿，你发布后才会写进各工具。',
            style: TextStyle(fontSize: 12.5, color: AuroraColors.fg2, height: 1.45),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _busy != null ? null : _regenerate,
              icon: _busy == 'regenerate'
                  ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.refresh_rounded, size: 18),
              label: Text(_busy == 'regenerate' ? '生成中…' : '现在生成草稿'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _banner(String text, Color color) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: GlassCard(
          padding: const EdgeInsets.all(12),
          child: Text(text, style: TextStyle(fontSize: 12.5, color: color)),
        ),
      );

  Widget _chip(String text, Color color, {IconData? icon}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: color.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(8)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[Icon(icon, size: 12, color: color), const SizedBox(width: 4)],
            Text(text, style: TextStyle(fontSize: 11.5, color: color, fontWeight: FontWeight.w600)),
          ],
        ),
      );

  Widget _buildEditor() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _editor,
          maxLines: null,
          minLines: 10,
          style: const TextStyle(fontSize: 13, height: 1.55, fontFamilyFallback: AuroraTheme.monospaceFontFamilyFallback),
          decoration: const InputDecoration(border: OutlineInputBorder()),
        ),
        const SizedBox(height: 10),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            TextButton(onPressed: _busy != null ? null : () => setState(() => _editing = null), child: const Text('取消')),
            const SizedBox(width: 8),
            FilledButton.icon(
              onPressed: _busy != null ? null : _saveDraft,
              icon: const Icon(Icons.check_rounded, size: 16),
              label: const Text('保存草稿'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildDraftCard() {
    final draft = _draft;
    final published = _published;
    final stats = (draft?['stats'] as Map?) ?? const {};
    final voice = stats['user_voice'] as Map?;
    final diff = draft == null ? null : personaLineDiff(draft['content'].toString(), published?['content']?.toString());

    return GlassCard(
      padding: const EdgeInsets.all(16),
      borderColor: draft != null ? AuroraColors.accent.withValues(alpha: 0.6) : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              _chip('待审草稿', draft != null ? AuroraColors.accent : AuroraColors.fg3, icon: Icons.edit_note_rounded),
              if (draft != null)
                Text(_formatTime(draft['updated_at']?.toString()), style: const TextStyle(fontSize: 11.5, color: AuroraColors.fg3)),
              if (voice != null)
                Text(
                  '依据 ${voice['kept']} 条你亲口说的话（${voice['corrections']} 条纠正）、${stats['memories'] ?? 0} 条记忆',
                  style: const TextStyle(fontSize: 11.5, color: AuroraColors.fg3),
                ),
            ],
          ),
          const SizedBox(height: 12),
          if (_editing != null && (_editing == 'draft' || draft == null))
            _buildEditor()
          else if (draft == null)
            const Text('暂无新草稿。每晚做梦后会自动生成，也可以现在生成一份。',
                style: TextStyle(fontSize: 13, color: AuroraColors.fg3))
          else ...[
            if (stats['edited_by_user'] == true)
              const Padding(
                padding: EdgeInsets.only(bottom: 10),
                child: Text('你改过这份草稿，夜间生成不会覆盖它。', style: TextStyle(fontSize: 12, color: AuroraColors.fg3)),
              ),
            if (diff != null && published != null && (diff.added.isNotEmpty || diff.removed.isNotEmpty)) ...[
              const Text('与已发布版本的差异',
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AuroraColors.fg2)),
              const SizedBox(height: 6),
              for (final l in diff.added)
                Text('+ ${l.substring(2)}', style: const TextStyle(fontSize: 12.5, color: AuroraColors.success, height: 1.5)),
              for (final l in diff.removed)
                Text('− ${l.substring(2)}',
                    style: const TextStyle(
                        fontSize: 12.5, color: AuroraColors.danger, height: 1.5, decoration: TextDecoration.lineThrough)),
              const SizedBox(height: 12),
            ],
            AppMarkdown(data: draft['content'].toString()),
            const SizedBox(height: 12),
            Wrap(
              alignment: WrapAlignment.end,
              spacing: 8,
              runSpacing: 8,
              children: [
                TextButton.icon(
                  onPressed: _busy != null ? null : () => _run('discard', _api.discardProfileDraft),
                  icon: const Icon(Icons.delete_outline_rounded, size: 16),
                  label: const Text('丢弃'),
                ),
                OutlinedButton.icon(
                  onPressed: _busy != null ? null : () => _startEditing('draft', draft['content'].toString()),
                  icon: const Icon(Icons.edit_outlined, size: 16),
                  label: const Text('编辑'),
                ),
                FilledButton.icon(
                  onPressed: _busy != null ? null : () => _run('publish', () => _api.publishProfile()),
                  icon: _busy == 'publish'
                      ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.rocket_launch_outlined, size: 16),
                  label: const Text('发布'),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildPublishedCard() {
    final published = _published;
    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _chip('已发布', published != null ? AuroraColors.success : AuroraColors.fg3, icon: Icons.check_rounded),
              const SizedBox(width: 8),
              if (published != null)
                Text('版本 ${published['version']} · ${_formatTime(published['published_at']?.toString())}',
                    style: const TextStyle(fontSize: 11.5, color: AuroraColors.fg3)),
              const Spacer(),
              if (_draft == null && _editing == null)
                TextButton.icon(
                  onPressed: () => _startEditing(
                      'published', published?['content']?.toString() ?? '### 沟通\n- \n\n### 铁律\n- \n'),
                  icon: const Icon(Icons.edit_outlined, size: 16),
                  label: const Text('编辑'),
                ),
            ],
          ),
          const SizedBox(height: 12),
          if (published != null)
            AppMarkdown(data: published['content'].toString())
          else
            const Text('还没有发布过画像。', style: TextStyle(fontSize: 13, color: AuroraColors.fg3)),
        ],
      ),
    );
  }

  Widget _buildDevicesCard() {
    final devices = ((_state?['devices'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final targets = ((_state?['targets'] as List?) ?? personaTargetMeta.keys.toList()).cast<String>();
    final publishedVersion = _published?['version'] as int?;

    return GlassCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('写入哪些工具', style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: AuroraColors.fg1)),
          const SizedBox(height: 4),
          const Text(
            '按设备单独开启。关闭后，采集器会在下一次同步（5 分钟内）把这段删掉；文件是 Memento 新建的会整个删除。',
            style: TextStyle(fontSize: 12, color: AuroraColors.fg3, height: 1.45),
          ),
          if (devices.isEmpty)
            const Padding(
              padding: EdgeInsets.only(top: 12),
              child: Text('还没有注册的设备。', style: TextStyle(fontSize: 13, color: AuroraColors.fg3)),
            ),
          for (final device in devices) _buildDevice(device, targets, publishedVersion),
        ],
      ),
    );
  }

  Widget _buildDevice(Map<String, dynamic> device, List<String> targets, int? publishedVersion) {
    final enabled = ((device['targets'] as List?) ?? const []).cast<String>();
    final status = (device['status'] as Map?) ?? const {};
    final results = ((status['results'] as Map?) ?? const {}).cast<String, dynamic>();

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.only(top: 12),
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: AuroraColors.border))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(splitDeviceName(device['name'].toString()).$1,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: AuroraColors.fg1)),
              if (device['online'] != true) _chip('离线', AuroraColors.fg3),
              if (status['reported_at'] != null)
                Text('上次同步 ${_formatTime(status['reported_at'].toString())}',
                    style: const TextStyle(fontSize: 11, color: AuroraColors.fg4)),
            ],
          ),
          const SizedBox(height: 10),
          // Side by side where there's room; one full-width row each on a phone.
          LayoutBuilder(
            builder: (context, constraints) => Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final tool in targets)
                  _buildToggle(
                    device,
                    tool,
                    fullWidth: constraints.maxWidth < 520,
                    on: enabled.contains(tool),
                    result: results[tool]?.toString(),
                    state: personaTargetState(
                      enabled: enabled.contains(tool),
                      result: results[tool]?.toString(),
                      reportedVersion: status['version'] as int?,
                      publishedVersion: publishedVersion,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _toggleLabel(String label, String file, bool on) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label,
              style: TextStyle(
                  fontSize: 13,
                  fontWeight: on ? FontWeight.w600 : FontWeight.w500,
                  color: on ? AuroraColors.fg1 : AuroraColors.fg2)),
          Text(file,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                  fontSize: 10.5, color: AuroraColors.fg4, fontFamilyFallback: AuroraTheme.monospaceFontFamilyFallback)),
        ],
      );

  Widget _buildToggle(Map<String, dynamic> device, String tool,
      {required bool on, required String? result, required PersonaTargetState? state, bool fullWidth = false}) {
    final (label, file) = personaTargetMeta[tool] ?? (tool, '');
    final (stateText, stateColor) = switch (state) {
      PersonaTargetState.written => ('已写入', AuroraColors.success),
      PersonaTargetState.upToDate => ('已是最新', AuroraColors.success),
      PersonaTargetState.skipped => ('未安装', AuroraColors.warn),
      PersonaTargetState.waiting => ('等待发布', AuroraColors.fg3),
      PersonaTargetState.error => ('出错', AuroraColors.danger),
      PersonaTargetState.pending => ('待同步', AuroraColors.fg3),
      null => ('', AuroraColors.fg3),
    };

    return Tooltip(
      message: state == PersonaTargetState.error ? (result ?? '') : file,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => _toggleTarget(device, tool),
        child: Container(
          width: fullWidth ? double.infinity : null,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          decoration: BoxDecoration(
            color: on ? AuroraColors.accentSoft : AuroraColors.chip,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: on ? AuroraColors.accent.withValues(alpha: 0.5) : Colors.transparent),
          ),
          child: Row(
            mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
            children: [
              Icon(on ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded,
                  size: 16, color: on ? AuroraColors.accent : AuroraColors.fg3),
              const SizedBox(width: 8),
              if (fullWidth) Expanded(child: _toggleLabel(label, file, on)) else _toggleLabel(label, file, on),
              if (state != null) ...[const SizedBox(width: 8), _chip(stateText, stateColor)],
            ],
          ),
        ),
      ),
    );
  }
}
