import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/theme/aurora_theme.dart';

/// Phone push (Bark) settings: where risky agent operations and finished tasks go.
Future<void> showNotifySettingsSheet(BuildContext context) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    backgroundColor: AuroraColors.surfaceSolid,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
    builder: (_) => const _NotifySettingsSheet(),
  );
}

class _NotifySettingsSheet extends StatefulWidget {
  const _NotifySettingsSheet();

  @override
  State<_NotifySettingsSheet> createState() => _NotifySettingsSheetState();
}

class _NotifySettingsSheetState extends State<_NotifySettingsSheet> {
  final _api = ApiClient();
  final _url = TextEditingController();
  Map<String, dynamic>? _settings;
  String? _message;
  bool _messageIsError = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final s = await _api.getNotifySettings();
      if (mounted) setState(() => _settings = s);
    } catch (e) {
      _show(_describe(e), error: true);
    }
  }

  String _describe(Object e) {
    if (e is DioException) {
      final data = e.response?.data;
      if (data is Map && data['detail'] != null) return data['detail'].toString();
      return e.message ?? e.toString();
    }
    return e.toString();
  }

  void _show(String text, {bool error = false}) {
    if (!mounted) return;
    setState(() {
      _message = text;
      _messageIsError = error;
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await action();
    } catch (e) {
      _show(_describe(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save(String url) => _run(() async {
        final s = await _api.saveNotifySettings(barkUrl: url);
        _url.clear();
        setState(() => _settings = s);
        _show(url.isEmpty ? '已清除推送地址' : '已保存，可以点「发送测试通知」确认一下');
      });

  Future<void> _toggle({bool? risky, bool? taskDone}) => _run(() async {
        final s = await _api.saveNotifySettings(notifyRisky: risky, notifyTaskDone: taskDone);
        setState(() => _settings = s);
      });

  Future<void> _test() => _run(() async {
        await _api.sendTestNotification();
        _show('已发送，看看手机有没有收到');
      });

  @override
  Widget build(BuildContext context) {
    final s = _settings;
    final configured = s?['bark_configured'] == true;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.notifications_active_outlined, color: AuroraColors.accent, size: 20),
              SizedBox(width: 8),
              Text('手机推送（Bark）',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AuroraColors.fg1)),
            ],
          ),
          const SizedBox(height: 8),
          const Text(
            '在 iPhone 上从 App Store 安装 Bark，打开后复制首页显示的推送地址（形如 https://api.day.app/xxxx），粘贴到下面保存。',
            style: TextStyle(fontSize: 12.5, color: AuroraColors.fg2, height: 1.5),
          ),
          const SizedBox(height: 14),
          if (s == null && _message == null)
            const Center(child: Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator()))
          else ...[
            Text(
              configured ? '当前：${s!['bark_masked']}' : '当前：未设置',
              style: TextStyle(fontSize: 12.5, color: configured ? AuroraColors.success : AuroraColors.fg3),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _url,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: InputDecoration(
                hintText: configured ? '粘贴新地址可替换' : 'https://api.day.app/…',
                border: const OutlineInputBorder(),
                isDense: true,
              ),
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton(
                  onPressed: _busy ? null : () => _save(_url.text.trim()),
                  child: const Text('保存'),
                ),
                OutlinedButton.icon(
                  onPressed: _busy || !configured ? null : _test,
                  icon: const Icon(Icons.send_outlined, size: 16),
                  label: const Text('发送测试通知'),
                ),
                if (configured)
                  TextButton(
                    onPressed: _busy ? null : () => _save(''),
                    child: const Text('清除'),
                  ),
              ],
            ),
            if (s != null) ...[
              const SizedBox(height: 8),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: s['notify_risky'] != false,
                onChanged: _busy ? null : (v) => _toggle(risky: v),
                title: const Text('危险操作', style: TextStyle(fontSize: 14, color: AuroraColors.fg1)),
                subtitle: const Text('agent 执行 git push、rm -rf、改凭据文件等操作时通知（不拦截）',
                    style: TextStyle(fontSize: 12, color: AuroraColors.fg3)),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: s['notify_task_done'] != false,
                onChanged: _busy ? null : (v) => _toggle(taskDone: v),
                title: const Text('任务完成', style: TextStyle(fontSize: 14, color: AuroraColors.fg1)),
                subtitle: const Text('agent 任务结束时，如果你没在看，就推送一条',
                    style: TextStyle(fontSize: 12, color: AuroraColors.fg3)),
              ),
            ],
          ],
          if (_message != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_message!,
                  style: TextStyle(fontSize: 12.5, color: _messageIsError ? AuroraColors.danger : AuroraColors.fg2)),
            ),
        ],
      ),
    );
  }
}
