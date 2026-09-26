import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core/api_client.dart';
import '../../core/theme/aurora_theme.dart';
import '../../models/search_hit.dart';
import '../widgets/glass_card.dart';
import '../widgets/app_markdown.dart';
import '../widgets/aurora_shimmer.dart';
import '../widgets/aurora_empty_state.dart';
import 'persona_tab.dart';

class MemoryScreen extends StatefulWidget {
  const MemoryScreen({super.key});

  @override
  State<MemoryScreen> createState() => _MemoryScreenState();
}

class _MemoryScreenState extends State<MemoryScreen> with SingleTickerProviderStateMixin {
  late TabController _tabController;

  // --- Tab 1: Search State ---
  final _searchController = TextEditingController();
  bool _semantic = true;
  bool _isSearchLoading = false;
  List<SearchHit> _hits = [];
  String? _searchError;

  // --- Tab 2: Core Memory State ---
  bool _isCoreLoading = false;
  bool _isTreeView = true;
  List<dynamic> _coreMemories = [];
  List<dynamic> _coreMemoryTree = [];
  final Set<String> _expandedTreePaths = {};
  String? _coreError;
  String? _selectedCategory;
  final _treeFilterController = TextEditingController();
  String _treeFilterQuery = '';

  // --- Tab 3: Dreaming State ---
  bool _isDreamLoading = false;
  bool _isDreamingRunning = false;
  List<dynamic> _dreamJournals = [];
  Map<String, dynamic>? _tierStats;
  String? _dreamError;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
    _tabController.addListener(() {
      if (_tabController.indexIsChanging) return;
      if (_tabController.index == 1 && _coreMemories.isEmpty && !_isCoreLoading) {
        _loadCoreMemories();
      } else if (_tabController.index == 2 && _dreamJournals.isEmpty && !_isDreamLoading) {
        _loadDreamData();
      }
    });
  }

  @override
  void dispose() {
    _tabController.dispose();
    _searchController.dispose();
    _treeFilterController.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Tab 1: Search Handlers
  // ---------------------------------------------------------------------------
  void _doSearch() async {
    final query = _searchController.text.trim();
    if (query.isEmpty) return;

    setState(() {
      _isSearchLoading = true;
      _searchError = null;
    });

    try {
      final res = await ApiClient().searchMemory(query, semantic: _semantic);
      final rawResults = res['results'] as List<dynamic>? ?? [];
      setState(() {
        _hits = rawResults.map((j) => SearchHit.fromJson(j)).toList();
        _isSearchLoading = false;
      });
    } catch (e) {
      setState(() {
        _searchError = '检索出错: $e';
        _isSearchLoading = false;
      });
    }
  }

  void _showDocumentDetail(String id, String title) async {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AuroraColors.surfaceSolid,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) {
        return DraggableScrollableSheet(
          initialChildSize: 0.85,
          minChildSize: 0.5,
          maxChildSize: 0.95,
          expand: false,
          builder: (context, scrollController) {
            return FutureBuilder<Map<String, dynamic>>(
              future: ApiClient().getDocument(id),
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator(color: AuroraColors.accent));
                }
                if (snapshot.hasError || !snapshot.hasData) {
                  return const Center(child: Text('加载文档失败', style: TextStyle(color: AuroraColors.danger)));
                }

                final doc = snapshot.data!;
                final content = doc['content']?.toString() ?? '无内容';
                final aiSummary = doc['ai_summary']?.toString();

                return ListView(
                  controller: scrollController,
                  padding: const EdgeInsets.all(20),
                  children: [
                    Center(
                      child: Container(
                        width: 36,
                        height: 4,
                        decoration: BoxDecoration(
                          color: AuroraColors.fg3.withValues(alpha: 0.4),
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      title,
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                        color: AuroraColors.fg1,
                      ),
                    ),
                    const SizedBox(height: 12),
                    if (aiSummary != null && aiSummary.isNotEmpty) ...[
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: AuroraColors.chip,
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: AuroraColors.border),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Row(
                              children: [
                                Icon(Icons.auto_awesome, size: 14, color: AuroraColors.accent),
                                SizedBox(width: 6),
                                Text(
                                  'AI 摘要',
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.bold,
                                    color: AuroraColors.accent,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 6),
                            Text(
                              aiSummary,
                              style: const TextStyle(fontSize: 13, color: AuroraColors.fg2, height: 1.4),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                    ],
                    const Divider(color: AuroraColors.border),
                    const SizedBox(height: 12),
                    AppMarkdown(data: content),
                  ],
                );
              },
            );
          },
        );
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Tab 2: Core Memory (MEMORY.md) Handlers
  // ---------------------------------------------------------------------------
  Future<void> _loadCoreMemories() async {
    setState(() {
      _isCoreLoading = true;
      _coreError = null;
    });
    try {
      final futures = await Future.wait([
        ApiClient().getCoreMemories(category: _selectedCategory),
        ApiClient().getCoreMemoryTree(category: _selectedCategory),
      ]);
      setState(() {
        _coreMemories = futures[0] as List<dynamic>;
        _coreMemoryTree = (futures[1] as Map<String, dynamic>)['tree'] as List<dynamic>? ?? [];
        _isCoreLoading = false;
        if (_expandedTreePaths.isEmpty) {
          _expandDefaultNodes(_coreMemoryTree);
        }
      });
    } catch (e) {
      setState(() {
        _coreError = '加载核心记忆失败: $e';
        _isCoreLoading = false;
      });
    }
  }

  void _expandDefaultNodes(List<dynamic> nodes) {
    for (final n in nodes) {
      if (n is Map<String, dynamic> && n['is_folder'] == true) {
        final tp = n['tree_path']?.toString();
        if (tp != null) _expandedTreePaths.add(tp);
        final children = n['children'] as List<dynamic>? ?? [];
        for (final c in children) {
          if (c is Map<String, dynamic> && c['is_folder'] == true) {
            final ctp = c['tree_path']?.toString();
            if (ctp != null) _expandedTreePaths.add(ctp);
          }
        }
      }
    }
  }

  void _toggleExpandAll() {
    setState(() {
      if (_expandedTreePaths.isNotEmpty) {
        _expandedTreePaths.clear();
      } else {
        _collectAllFolderPaths(_coreMemoryTree, _expandedTreePaths);
      }
    });
  }

  void _collectAllFolderPaths(List<dynamic> nodes, Set<String> result) {
    for (final n in nodes) {
      if (n is Map<String, dynamic> && n['is_folder'] == true) {
        final tp = n['tree_path']?.toString();
        if (tp != null) result.add(tp);
        final children = n['children'] as List<dynamic>? ?? [];
        _collectAllFolderPaths(children, result);
      }
    }
  }


  void _showFullMemoryMarkdown() async {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AuroraColors.surfaceSolid,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) {
        return DraggableScrollableSheet(
          initialChildSize: 0.85,
          minChildSize: 0.5,
          maxChildSize: 0.95,
          expand: false,
          builder: (context, scrollController) {
            return FutureBuilder<String>(
              future: ApiClient().getCoreMemoryMarkdown(),
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator(color: AuroraColors.accent));
                }
                final md = snapshot.data ?? '无内容';
                return ListView(
                  controller: scrollController,
                  padding: const EdgeInsets.all(20),
                  children: [
                    Center(
                      child: Container(
                        width: 36,
                        height: 4,
                        decoration: BoxDecoration(
                          color: AuroraColors.fg3.withValues(alpha: 0.4),
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    const Row(
                      children: [
                        Icon(Icons.description_outlined, color: AuroraColors.accent, size: 20),
                        SizedBox(width: 8),
                        Text(
                          'MEMORY.md 全文预览',
                          style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: AuroraColors.fg1),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    AppMarkdown(data: md),
                  ],
                );
              },
            );
          },
        );
      },
    );
  }

  void _showAddOrEditMemoryDialog({
    Map<String, dynamic>? existing,
    String? defaultParentId,
    String? defaultTreePath,
    bool isFolderDefault = false,
  }) {
    final catController = TextEditingController(text: existing?['category'] ?? 'rule');
    final keyController = TextEditingController(text: existing?['key'] ?? '');
    final contentController = TextEditingController(text: existing?['content'] ?? '');
    final pathController = TextEditingController(
      text: existing?['tree_path'] ?? defaultTreePath ?? '',
    );
    bool isFolder = existing?['is_folder'] == true || isFolderDefault;
    final parentId = existing?['parent_id']?.toString() ?? defaultParentId;
    final isEdit = existing != null;

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          backgroundColor: AuroraColors.surfaceSolid,
          title: Text(
            isEdit
                ? (isFolder ? '编辑目录分支' : '编辑核心记忆')
                : (isFolder ? '新建目录分支' : '添加长期核心记忆'),
            style: const TextStyle(color: AuroraColors.fg1, fontSize: 16),
          ),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Switch(
                      value: isFolder,
                      activeThumbColor: AuroraColors.accent,
                      onChanged: (val) {
                        setDialogState(() {
                          isFolder = val;
                        });
                      },
                    ),
                    const SizedBox(width: 8),
                    Text(
                      isFolder ? '📁 分支目录 (Folder Node)' : '📄 记忆条目 (Leaf Node)',
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.bold,
                        color: isFolder ? AuroraColors.accent : AuroraColors.fg2,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  initialValue: ['rule', 'architecture', 'preference', 'project', 'general'].contains(catController.text)
                      ? catController.text
                      : 'general',
                  dropdownColor: AuroraColors.surfaceSolid,
                  style: const TextStyle(color: AuroraColors.fg1, fontSize: 13.5),
                  decoration: const InputDecoration(labelText: '根分类 (Category)'),
                  items: const [
                    DropdownMenuItem(value: 'rule', child: Text('规范铁律 (rule)')),
                    DropdownMenuItem(value: 'architecture', child: Text('架构决策 (architecture)')),
                    DropdownMenuItem(value: 'preference', child: Text('偏好习惯 (preference)')),
                    DropdownMenuItem(value: 'project', child: Text('项目约束 (project)')),
                    DropdownMenuItem(value: 'general', child: Text('通用常识 (general)')),
                  ],
                  onChanged: (v) => catController.text = v ?? 'general',
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: keyController,
                  style: const TextStyle(color: AuroraColors.fg1, fontSize: 13.5),
                  decoration: InputDecoration(
                    labelText: isFolder ? '目录名称 (Key，如 desktop)' : '主题标识 (Key，如 windows_update_policy)',
                    hintText: '英文小写与下划线',
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: pathController,
                  style: const TextStyle(color: AuroraColors.fg1, fontSize: 13.5),
                  decoration: const InputDecoration(
                    labelText: '树状路径 (Tree Path，可选)',
                    hintText: '例如 /rules/desktop/windows_update',
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: contentController,
                  maxLines: isFolder ? 2 : 4,
                  style: const TextStyle(color: AuroraColors.fg1, fontSize: 13.5),
                  decoration: InputDecoration(
                    labelText: isFolder ? '目录说明 (Description)' : '记忆准则内容 (Content)',
                    hintText: isFolder ? '简要描述该分支收录的规则或模块...' : '描述具体规范、铁律或配置习惯...',
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('取消', style: TextStyle(color: AuroraColors.fg3)),
            ),
            ElevatedButton(
              onPressed: () async {
                final cat = catController.text.trim();
                final key = keyController.text.trim();
                final content = contentController.text.trim();
                final path = pathController.text.trim().isEmpty ? null : pathController.text.trim();
                if (key.isEmpty || content.isEmpty) return;

                Navigator.pop(ctx);
                try {
                  if (isEdit) {
                    await ApiClient().updateCoreMemory(
                      existing['id'].toString(),
                      category: cat,
                      key: key,
                      content: content,
                      treePath: path,
                      isFolder: isFolder,
                    );
                  } else {
                    await ApiClient().createCoreMemory(
                      cat,
                      key,
                      content,
                      parentId: parentId,
                      treePath: path,
                      isFolder: isFolder,
                    );
                  }
                  _loadCoreMemories();
                } catch (e) {
                  if (!mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('保存失败: $e')));
                }
              },
              child: const Text('保存'),
            ),
          ],
        ),
      ),
    );
  }

  void _deleteMemory(String id) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AuroraColors.surfaceSolid,
        title: const Text('确认遗忘？', style: TextStyle(color: AuroraColors.fg1)),
        content: const Text('该条长期记忆将被永久移除。', style: TextStyle(color: AuroraColors.fg2)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('遗忘', style: TextStyle(color: AuroraColors.danger)),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      try {
        await ApiClient().deleteCoreMemory(id);
        _loadCoreMemories();
      } catch (e) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('删除失败: $e')));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tab 3: Dreaming & Journal Handlers
  // ---------------------------------------------------------------------------
  Future<void> _loadDreamData() async {
    setState(() {
      _isDreamLoading = true;
      _dreamError = null;
    });
    try {
      final tiersFuture = ApiClient().getMemoryTiers();
      final journalsFuture = ApiClient().getDreamJournals(limit: 20);
      final results = await Future.wait([tiersFuture, journalsFuture]);

      setState(() {
        _tierStats = results[0];
        _dreamJournals = results[1]['journals'] as List<dynamic>? ?? [];
        _isDreamLoading = false;
      });
    } catch (e) {
      setState(() {
        _dreamError = '加载做梦数据失败: $e';
        _isDreamLoading = false;
      });
    }
  }

  void _triggerDreamingNow({int daysBack = 1}) async {
    setState(() => _isDreamingRunning = true);
    try {
      final res = await ApiClient().triggerDream(daysBack: daysBack);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(daysBack == 0
              ? '🌌 全历史全景做梦反思与记忆固化已完成 (涵盖全部历史核心项目)！'
              : '🌙 做梦反思与记忆固化已完成 (涵盖近 $daysBack 天)！'),
          backgroundColor: AuroraColors.accent,
        ),
      );
      _loadDreamData();
      _loadCoreMemories();
      if (res['report_markdown'] != null) {
        _showDreamReportModal(res['report_markdown'].toString());
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('做梦反思失败: $e'), backgroundColor: AuroraColors.danger),
      );
    } finally {
      if (mounted) {
        setState(() => _isDreamingRunning = false);
      }
    }
  }

  void _startBackfill() async {
    setState(() => _isDreamingRunning = true);
    try {
      final res = await ApiClient().triggerDreamBackfill(chunkDays: 3, maxChunks: 30, runAsync: true);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(res['message']?.toString() ?? '历史记忆渐进回填已启动，系统正在后台分批推演...'),
          backgroundColor: AuroraColors.accent,
        ),
      );
      _pollBackfillProgress();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('启动历史回填失败: $e'), backgroundColor: AuroraColors.danger),
      );
      setState(() => _isDreamingRunning = false);
    }
  }

  void _pollBackfillProgress() async {
    for (int i = 0; i < 60; i++) {
      await Future.delayed(const Duration(seconds: 3));
      if (!mounted) return;
      try {
        final status = await ApiClient().getDreamBackfillStatus();
        final state = status['status']?.toString();
        if (state == 'completed') {
          if (!mounted) return;
          setState(() => _isDreamingRunning = false);
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('🎉 历史记忆全量回溯做梦已全部完成！'),
              backgroundColor: AuroraColors.accent,
            ),
          );
          _loadDreamData();
          _loadCoreMemories();
          break;
        } else if (state == 'error') {
          if (!mounted) return;
          setState(() => _isDreamingRunning = false);
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('历史回填发生异常: ${status['error']}'),
              backgroundColor: AuroraColors.danger,
            ),
          );
          break;
        }
      } catch (_) {}
    }
    if (mounted) {
      setState(() => _isDreamingRunning = false);
    }
  }

  void _startBootstrap() async {
    setState(() => _isDreamingRunning = true);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('⚡ 正在从历史知识图谱与核心会话中自举提炼认知记忆树...'),
        backgroundColor: AuroraColors.accent,
      ),
    );
    try {
      final res = await ApiClient().bootstrapMemories();
      final promoted = res['promoted_count'] ?? 0;
      await Future.wait([
        _loadCoreMemories(),
        _loadDreamData(),
      ]);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('🎉 成功自举沉淀 $promoted 条长期核心记忆！'),
            backgroundColor: AuroraColors.accent,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('自举提炼失败: $e'), backgroundColor: AuroraColors.danger),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _isDreamingRunning = false);
      }
    }
  }

  void _showDreamScopeDialog() {
    showModalBottomSheet(
      context: context,
      backgroundColor: AuroraColors.surfaceSolid,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '选择做梦反思范围 (Consolidation Scope)',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AuroraColors.fg1),
              ),
              const SizedBox(height: 6),
              const Text(
                '系统将分析选定时间段内的所有对话、工具流与研发小结，提炼核心记忆。',
                style: TextStyle(fontSize: 12, color: AuroraColors.fg3),
              ),
              const SizedBox(height: 14),
              ListTile(
                leading: const Icon(Icons.auto_awesome, color: AuroraColors.accent),
                title: const Text('🌌 全历史全景做梦 (Full-History Deep Dreaming)', style: TextStyle(color: AuroraColors.fg1, fontSize: 13.5, fontWeight: FontWeight.bold)),
                subtitle: const Text('涵盖全部历史 18+ 核心项目、跨年度技术栈与开发规范，全量深睡固化（最全）', style: TextStyle(color: AuroraColors.fg3, fontSize: 11)),
                onTap: () {
                  Navigator.pop(ctx);
                  _triggerDreamingNow(daysBack: 0);
                },
              ),
              ListTile(
                leading: const Icon(Icons.bolt, color: Colors.amber),
                title: const Text('全量知识图谱冷启动自举 (Knowledge Bootstrap)', style: TextStyle(color: AuroraColors.fg1, fontSize: 13.5, fontWeight: FontWeight.bold)),
                subtitle: const Text('从全量历史 2,900+ 技术实体、项目与观察中秒级抽取初始认知树', style: TextStyle(color: AuroraColors.fg3, fontSize: 11)),
                onTap: () {
                  Navigator.pop(ctx);
                  _startBootstrap();
                },
              ),
              ListTile(
                leading: const Icon(Icons.nightlight_round, color: AuroraColors.accent),
                title: const Text('沉淀最近 24 小时 (近 1 天)', style: TextStyle(color: AuroraColors.fg1, fontSize: 13.5)),
                subtitle: const Text('常规夜间增量做梦，提炼昨天的最新开发共识', style: TextStyle(color: AuroraColors.fg3, fontSize: 11)),
                onTap: () {
                  Navigator.pop(ctx);
                  _triggerDreamingNow(daysBack: 1);
                },
              ),
              ListTile(
                leading: const Icon(Icons.date_range, color: AuroraColors.accent),
                title: const Text('沉淀最近 7 天', style: TextStyle(color: AuroraColors.fg1, fontSize: 13.5)),
                subtitle: const Text('周期性回顾，提炼本周的整体技术演进与架构决策', style: TextStyle(color: AuroraColors.fg3, fontSize: 11)),
                onTap: () {
                  Navigator.pop(ctx);
                  _triggerDreamingNow(daysBack: 7);
                },
              ),
              ListTile(
                leading: const Icon(Icons.calendar_month, color: AuroraColors.accent),
                title: const Text('沉淀最近 30 天', style: TextStyle(color: AuroraColors.fg1, fontSize: 13.5)),
                subtitle: const Text('月度反思，全面提炼近一个月内的深层研发偏好与规范', style: TextStyle(color: AuroraColors.fg3, fontSize: 11)),
                onTap: () {
                  Navigator.pop(ctx);
                  _triggerDreamingNow(daysBack: 30);
                },
              ),
              ListTile(
                leading: const Icon(Icons.history_edu, color: AuroraColors.danger),
                title: const Text('全量历史记忆渐进回填 (Backfill Replay)', style: TextStyle(color: AuroraColors.fg1, fontSize: 13.5, fontWeight: FontWeight.bold)),
                subtitle: const Text('从最早的历史记录按时间切片（每3天）逐步递推演化至今天', style: TextStyle(color: AuroraColors.fg3, fontSize: 11)),
                onTap: () {
                  Navigator.pop(ctx);
                  _startBackfill();
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showDreamReportModal(String markdown) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AuroraColors.surfaceSolid,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) {
        return DraggableScrollableSheet(
          initialChildSize: 0.85,
          minChildSize: 0.5,
          maxChildSize: 0.95,
          expand: false,
          builder: (context, scrollController) {
            return ListView(
              controller: scrollController,
              padding: const EdgeInsets.all(20),
              children: [
                Center(
                  child: Container(
                    width: 36,
                    height: 4,
                    decoration: BoxDecoration(
                      color: AuroraColors.fg3.withValues(alpha: 0.4),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                AppMarkdown(data: markdown),
              ],
            );
          },
        );
      },
    );
  }

  void _showDreamJournalDetail(String id) async {
    try {
      final detail = await ApiClient().getDreamJournalDetail(id);
      final md = detail['report_markdown']?.toString() ?? '无报告内容';
      _showDreamReportModal(md);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('获取梦境日记失败: $e')));
    }
  }

  // ---------------------------------------------------------------------------
  // Build Methods
  // ---------------------------------------------------------------------------
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AuroraColors.bg,
      appBar: AppBar(
        backgroundColor: AuroraColors.bg,
        elevation: 0,
        titleSpacing: 20,
        title: const Text('记忆库'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            padding: const EdgeInsets.all(3),
            // Segmented control: a quiet track with the selection as a solid block.
            decoration: BoxDecoration(
              color: AuroraColors.surfaceSolid,
              borderRadius: BorderRadius.circular(12),
            ),
            child: TabBar(
              controller: _tabController,
              // Four labelled tabs don't fit side by side on a phone.
              isScrollable: MediaQuery.sizeOf(context).width < 640,
              tabAlignment: MediaQuery.sizeOf(context).width < 640 ? TabAlignment.start : TabAlignment.fill,
              indicator: BoxDecoration(
                color: AuroraColors.surfaceElevated,
                borderRadius: BorderRadius.circular(9),
              ),
              splashBorderRadius: BorderRadius.circular(9),
              indicatorSize: TabBarIndicatorSize.tab,
              dividerColor: Colors.transparent,
              labelColor: AuroraColors.fg1,
              unselectedLabelColor: AuroraColors.fg3,
              labelStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
              unselectedLabelStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
              tabs: [
                Tab(
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.search_rounded, size: 16),
                      const SizedBox(width: 6),
                      const Text('检索与图谱'),
                      if (_hits.isNotEmpty) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                          decoration: BoxDecoration(
                            color: AuroraColors.accent.withValues(alpha: 0.2),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Text('${_hits.length}', style: const TextStyle(fontSize: 10, color: AuroraColors.accent)),
                        ),
                      ],
                    ],
                  ),
                ),
                Tab(
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.account_tree_rounded, size: 16),
                      const SizedBox(width: 6),
                      const Text('长期核心准则'),
                      if (_coreMemories.isNotEmpty) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                          decoration: BoxDecoration(
                            color: const Color(0xFF10B981).withValues(alpha: 0.2),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Text('${_coreMemories.length}', style: const TextStyle(fontSize: 10, color: Color(0xFF10B981))),
                        ),
                      ],
                    ],
                  ),
                ),
                Tab(
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.auto_awesome_rounded, size: 16),
                      const SizedBox(width: 6),
                      const Text('做梦与认知分层'),
                      if (_dreamJournals.isNotEmpty) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                          decoration: BoxDecoration(
                            color: const Color(0xFFA855F7).withValues(alpha: 0.2),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Text('${_dreamJournals.length}', style: const TextStyle(fontSize: 10, color: Color(0xFFA855F7))),
                        ),
                      ],
                    ],
                  ),
                ),
                const Tab(
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.badge_outlined, size: 16),
                      SizedBox(width: 6),
                      Text('常驻画像'),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildSearchTab(),
          _buildCoreMemoryTab(),
          _buildDreamingTab(),
          const PersonaTab(),
        ],
      ),
    );
  }

  // --- View: Tab 1 (Search) ---
  Widget _buildSearchTab() {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: AuroraColors.border, width: 0.5)),
          ),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _searchController,
                  textInputAction: TextInputAction.search,
                  onSubmitted: (_) => _doSearch(),
                  style: const TextStyle(color: AuroraColors.fg1, fontSize: 14),
                  decoration: InputDecoration(
                    hintText: '搜索过去的研发对话、代码与笔记...',
                    hintStyle: const TextStyle(color: AuroraColors.fg3, fontSize: 13.5),
                    prefixIcon: const Icon(Icons.search, color: AuroraColors.fg3, size: 20),
                    suffixIcon: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Tooltip(
                          message: _semantic ? '语义向量检索 (BGE-M3)' : '全文检索 (FTS)',
                          child: InkWell(
                            borderRadius: BorderRadius.circular(12),
                            onTap: () => setState(() => _semantic = !_semantic),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 8),
                              child: Row(
                                children: [
                                  Icon(
                                    _semantic ? Icons.auto_awesome : Icons.text_snippet,
                                    size: 15,
                                    color: _semantic ? AuroraColors.accent : AuroraColors.fg3,
                                  ),
                                  const SizedBox(width: 4),
                                  Text(
                                    _semantic ? '语义' : '全文',
                                    style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: FontWeight.bold,
                                      color: _semantic ? AuroraColors.accent : AuroraColors.fg3,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                        if (_searchController.text.isNotEmpty)
                          IconButton(
                            icon: const Icon(Icons.clear, size: 18, color: AuroraColors.fg3),
                            onPressed: () {
                              _searchController.clear();
                              setState(() => _hits.clear());
                            },
                          ),
                      ],
                    ),
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 10),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                      borderSide: const BorderSide(color: AuroraColors.border),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                      borderSide: const BorderSide(color: AuroraColors.accent),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              ElevatedButton(
                onPressed: _isSearchLoading ? null : _doSearch,
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                ),
                child: _isSearchLoading
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black),
                      )
                    : const Text('检索'),
              ),
            ],
          ),
        ),
        if (_searchError != null)
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(_searchError!, style: const TextStyle(color: AuroraColors.danger, fontSize: 13)),
          ),
        Expanded(
          child: _isSearchLoading
              ? const AuroraListSkeleton(count: 4)
              : _hits.isEmpty
                  ? ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      children: const [
                        SizedBox(height: 36),
                        AuroraEmptyState(
                          icon: Icons.saved_search_rounded,
                          title: '跨设备智能记忆检索',
                          description: '输入任何关键词、函数名、报错日志或自然语言问题。\nMemento 基于向量语义与文本倒排索引穿透跨设备工作记录。',
                        ),
                      ],
                    )
                  : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: _hits.length,
                  itemBuilder: (context, index) {
                    final hit = _hits[index];
                    return Container(
                      margin: const EdgeInsets.only(bottom: 12),
                      child: GlassCard(
                        padding: const EdgeInsets.all(14),
                        onTap: () => _showDocumentDetail(hit.id, hit.title ?? hit.relativePath),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                  decoration: BoxDecoration(
                                    color: AuroraColors.chip,
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                  child: Text(
                                    hit.toolId.toUpperCase(),
                                    style: const TextStyle(
                                      fontSize: 10.5,
                                      fontWeight: FontWeight.bold,
                                      color: AuroraColors.accent,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    hit.title ?? hit.relativePath,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontSize: 13.5,
                                      fontWeight: FontWeight.w600,
                                      color: AuroraColors.fg1,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            Text(
                              hit.snippet,
                              maxLines: 3,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 12,
                                color: AuroraColors.fg2,
                                height: 1.4,
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }

  // --- View: Tab 2 (Core Memory / MEMORY.md) ---
  List<dynamic> _filterTreeNodes(List<dynamic> nodes, String query) {
    if (query.isEmpty) return nodes;
    final q = query.toLowerCase().trim();
    final List<dynamic> filtered = [];

    for (final node in nodes) {
      if (node is! Map<String, dynamic>) continue;
      final isFolder = node['is_folder'] == true;
      final name = (node['name']?.toString() ?? '').toLowerCase();
      final title = (node['title']?.toString() ?? '').toLowerCase();
      final key = (node['key']?.toString() ?? '').toLowerCase();
      final content = (node['content']?.toString() ?? '').toLowerCase();
      final treePath = (node['tree_path']?.toString() ?? '').toLowerCase();

      final selfMatches = name.contains(q) ||
          title.contains(q) ||
          key.contains(q) ||
          content.contains(q) ||
          treePath.contains(q);

      if (isFolder) {
        final children = node['children'] as List<dynamic>? ?? [];
        final filteredChildren = _filterTreeNodes(children, query);
        if (selfMatches || filteredChildren.isNotEmpty) {
          final copy = Map<String, dynamic>.from(node);
          copy['children'] = filteredChildren.isNotEmpty ? filteredChildren : children;
          filtered.add(copy);
          final tp = node['tree_path']?.toString();
          if (tp != null) _expandedTreePaths.add(tp);
        }
      } else {
        if (selfMatches) {
          filtered.add(node);
        }
      }
    }
    return filtered;
  }

  int _countCategoryLeaves(String? cat) {
    if (cat == null) return _coreMemories.length;
    return _coreMemories.where((m) {
      final c = (m['category']?.toString() ?? '').toLowerCase();
      if (cat == 'rules' || cat == 'rule') return c == 'rule' || c == 'rules';
      if (cat == 'tools' || cat == 'tool') return c == 'tool' || c == 'tools';
      return c == cat.toLowerCase();
    }).length;
  }

  IconData _getProjectIcon(String slug) {
    final s = slug.toLowerCase();
    if (s.contains('quant') || s.contains('bot') || s.contains('backtest') || s.contains('maker')) {
      return Icons.candlestick_chart_rounded;
    }
    if (s.contains('chem') || s.contains('pubchem') || s.contains('cas') || s.contains('reaction') || s.contains('scifinder') || s.contains('smiles') || s.contains('reaxys')) {
      return Icons.science_rounded;
    }
    if (s.contains('desktop') || s.contains('kasm') || s.contains('webrtc') || s.contains('openclaw')) {
      return Icons.desktop_windows_rounded;
    }
    if (s.contains('k8s') || s.contains('vps') || s.contains('infra') || s.contains('monitor') || s.contains('gateway')) {
      return Icons.dns_rounded;
    }
    if (s.contains('chat') || s.contains('copilot') || s.contains('wechat') || s.contains('voice')) {
      return Icons.forum_rounded;
    }
    if (s.contains('aicut') || s.contains('film')) {
      return Icons.movie_filter_rounded;
    }
    if (s.contains('ray') || s.contains('ml') || s.contains('sglang') || s.contains('mem0')) {
      return Icons.memory_rounded;
    }
    if (s.contains('sso') || s.contains('pay') || s.contains('zentao') || s.contains('yicaigou') || s.contains('daily')) {
      return Icons.token_rounded;
    }
    return Icons.folder_rounded;
  }

  Color _getProjectBadgeColor(String slug) {
    final s = slug.toLowerCase();
    if (s.contains('quant') || s.contains('bot') || s.contains('maker')) return const Color(0xFF10B981);
    if (s.contains('chem') || s.contains('pubchem') || s.contains('cas') || s.contains('scifinder')) return const Color(0xFF06B6D4);
    if (s.contains('desktop') || s.contains('kasm') || s.contains('openclaw')) return const Color(0xFF8B5CF6);
    if (s.contains('k8s') || s.contains('vps') || s.contains('infra')) return const Color(0xFF3B82F6);
    if (s.contains('chat') || s.contains('copilot') || s.contains('daily')) return const Color(0xFFEC4899);
    return const Color(0xFF6366F1);
  }

  Widget _buildModernCategoryPill(String? category, String label, IconData icon, Color color) {
    final selected = _selectedCategory == category;
    final count = _countCategoryLeaves(category);

    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: InkWell(
        onTap: () {
          setState(() {
            _selectedCategory = selected ? null : category;
          });
          _loadCoreMemories();
        },
        borderRadius: BorderRadius.circular(20),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5.5),
          decoration: BoxDecoration(
            color: selected ? color.withValues(alpha: 0.18) : AuroraColors.surface,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: selected ? color.withValues(alpha: 0.8) : AuroraColors.border,
              width: selected ? 1.2 : 0.8,
            ),
            boxShadow: selected
                ? [
                    BoxShadow(
                      color: color.withValues(alpha: 0.25),
                      blurRadius: 8,
                      offset: const Offset(0, 2),
                    ),
                  ]
                : null,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 14, color: selected ? color : AuroraColors.fg3),
              const SizedBox(width: 5),
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: selected ? FontWeight.bold : FontWeight.w500,
                  color: selected ? AuroraColors.fg1 : AuroraColors.fg2,
                ),
              ),
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 5.5, vertical: 1),
                decoration: BoxDecoration(
                  color: selected ? color.withValues(alpha: 0.25) : AuroraColors.chip,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  '$count',
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.bold,
                    color: selected ? color : AuroraColors.fg3,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildCoreMemoryTab() {
    return Column(
      children: [
        // Top Dimension HUD & Metric Bar
        Container(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 10),
          decoration: const BoxDecoration(
            color: AuroraColors.bg2,
            border: Border(bottom: BorderSide(color: AuroraColors.border, width: 0.8)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Dimension Filter Pills (HUD)
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    _buildModernCategoryPill(null, '全部准则', Icons.grid_view_rounded, const Color(0xFF94A3B8)),
                    _buildModernCategoryPill('project', '核心工程', Icons.rocket_launch_rounded, const Color(0xFF10B981)),
                    _buildModernCategoryPill('architecture', '架构决策', Icons.account_tree_rounded, const Color(0xFF38BDF8)),
                    _buildModernCategoryPill('rules', '工程铁律', Icons.shield_outlined, const Color(0xFFF59E0B)),
                    _buildModernCategoryPill('tools', '工具中台', Icons.construction_rounded, const Color(0xFFFB923C)),
                    _buildModernCategoryPill('preference', '开发偏好', Icons.psychology_outlined, const Color(0xFFA855F7)),
                  ],
                ),
              ),
              const SizedBox(height: 10),

              // Live Search & Control Action Bar: one row when there's room; on a
              // phone the filter gets its own line and the buttons scroll beneath it.
              LayoutBuilder(builder: (context, constraints) {
                final filter = Container(
                      height: 36,
                      decoration: BoxDecoration(
                        color: AuroraColors.surface,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(
                          color: _treeFilterQuery.isNotEmpty
                              ? AuroraColors.accent.withValues(alpha: 0.6)
                              : AuroraColors.border,
                          width: 0.8,
                        ),
                      ),
                      child: TextField(
                        controller: _treeFilterController,
                        onChanged: (val) {
                          setState(() {
                            _treeFilterQuery = val.trim();
                          });
                        },
                        style: const TextStyle(color: AuroraColors.fg1, fontSize: 13),
                        decoration: InputDecoration(
                          hintText: '过滤工程、技术标识或规则关键词...',
                          hintStyle: const TextStyle(color: AuroraColors.fg3, fontSize: 12),
                          prefixIcon: const Icon(Icons.filter_list_rounded, color: AuroraColors.fg3, size: 17),
                          suffixIcon: _treeFilterQuery.isNotEmpty
                              ? IconButton(
                                  icon: const Icon(Icons.clear, size: 15, color: AuroraColors.fg3),
                                  onPressed: () {
                                    _treeFilterController.clear();
                                    setState(() {
                                      _treeFilterQuery = '';
                                    });
                                  },
                                )
                              : null,
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(vertical: 8),
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                        ),
                      ),
                    );
                final actions = Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [

                  // View Toggle (Tree vs Flat)
                  Container(
                    height: 36,
                    padding: const EdgeInsets.all(2.5),
                    decoration: BoxDecoration(
                      color: AuroraColors.surface,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AuroraColors.border, width: 0.8),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        InkWell(
                          onTap: () => setState(() => _isTreeView = true),
                          borderRadius: BorderRadius.circular(7),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                            decoration: BoxDecoration(
                              color: _isTreeView ? AuroraColors.accent.withValues(alpha: 0.22) : Colors.transparent,
                              borderRadius: BorderRadius.circular(7),
                            ),
                            child: Row(
                              children: [
                                Icon(
                                  Icons.account_tree_outlined,
                                  size: 14,
                                  color: _isTreeView ? AuroraColors.accent : AuroraColors.fg3,
                                ),
                                const SizedBox(width: 4),
                                Text(
                                  '树状目录',
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: _isTreeView ? FontWeight.bold : FontWeight.normal,
                                    color: _isTreeView ? AuroraColors.accent : AuroraColors.fg3,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        InkWell(
                          onTap: () => setState(() => _isTreeView = false),
                          borderRadius: BorderRadius.circular(7),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                            decoration: BoxDecoration(
                              color: !_isTreeView ? AuroraColors.accent.withValues(alpha: 0.22) : Colors.transparent,
                              borderRadius: BorderRadius.circular(7),
                            ),
                            child: Row(
                              children: [
                                Icon(
                                  Icons.view_headline_outlined,
                                  size: 14,
                                  color: !_isTreeView ? AuroraColors.accent : AuroraColors.fg3,
                                ),
                                const SizedBox(width: 4),
                                Text(
                                  '平铺列表',
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: !_isTreeView ? FontWeight.bold : FontWeight.normal,
                                    color: !_isTreeView ? AuroraColors.accent : AuroraColors.fg3,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),

                  if (_isTreeView) ...[
                    const SizedBox(width: 8),
                    InkWell(
                      onTap: _toggleExpandAll,
                      borderRadius: BorderRadius.circular(8),
                      child: Container(
                        height: 36,
                        padding: const EdgeInsets.symmetric(horizontal: 10),
                        decoration: BoxDecoration(
                          color: AuroraColors.surface,
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: AuroraColors.border, width: 0.8),
                        ),
                        child: Row(
                          children: [
                            Icon(
                              _expandedTreePaths.isNotEmpty ? Icons.unfold_less_rounded : Icons.unfold_more_rounded,
                              size: 16,
                              color: AuroraColors.fg2,
                            ),
                            const SizedBox(width: 4),
                            Text(
                              _expandedTreePaths.isNotEmpty ? '折叠' : '展开',
                              style: const TextStyle(fontSize: 11.5, color: AuroraColors.fg2),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],

                  const SizedBox(width: 8),
                  // MEMORY.md Full Markdown preview button
                  InkWell(
                    onTap: _showFullMemoryMarkdown,
                    borderRadius: BorderRadius.circular(8),
                    child: Container(
                      height: 36,
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      decoration: BoxDecoration(
                        color: AuroraColors.surface,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: AuroraColors.accent.withValues(alpha: 0.4), width: 0.8),
                      ),
                      child: const Row(
                        children: [
                          Icon(Icons.menu_book_rounded, color: AuroraColors.accent, size: 16),
                          SizedBox(width: 4),
                          Text(
                            'MEMORY.md',
                            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: AuroraColors.accent),
                          ),
                        ],
                      ),
                    ),
                  ),

                  const SizedBox(width: 8),
                  // Add Memory Button
                  ElevatedButton.icon(
                    icon: const Icon(Icons.add_rounded, size: 16),
                    label: const Text('新增', style: TextStyle(fontSize: 12)),
                    style: ElevatedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      minimumSize: const Size(0, 36),
                    ),
                    onPressed: () => _showAddOrEditMemoryDialog(),
                  ),
                  ],
                );
                if (constraints.maxWidth < 640) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      filter,
                      const SizedBox(height: 8),
                      SingleChildScrollView(scrollDirection: Axis.horizontal, child: actions),
                    ],
                  );
                }
                return Row(children: [Expanded(child: filter), const SizedBox(width: 10), actions]);
              }),
            ],
          ),
        ),

        if (_coreError != null)
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(_coreError!, style: const TextStyle(color: AuroraColors.danger, fontSize: 13)),
          ),

        Expanded(
          child: _isCoreLoading
              ? const AuroraListSkeleton(count: 5)
              : _isTreeView
                  ? _buildDirectoryTreeView()
                  : _buildFlatListView(),
        ),
      ],
    );
  }

  int _countLeaves(Map<String, dynamic> n) {
    if (n['is_folder'] != true) return 1;
    int sum = 0;
    for (final c in (n['children'] as List<dynamic>? ?? [])) {
      if (c is Map<String, dynamic>) {
        sum += _countLeaves(c);
      }
    }
    return sum;
  }

  Color _getCategoryColor(String cat) {
    switch (cat.toLowerCase()) {
      case 'rule':
      case 'rules':
        return const Color(0xFFF59E0B);
      case 'architecture':
        return const Color(0xFF38BDF8);
      case 'preference':
        return const Color(0xFFA855F7);
      case 'project':
        return const Color(0xFF10B981);
      case 'tools':
      case 'tool':
        return const Color(0xFFFB923C);
      default:
        return AuroraColors.accent;
    }
  }

  IconData _getDimensionIcon(String path) {
    if (path.startsWith('/architecture')) return Icons.account_tree_rounded;
    if (path.startsWith('/rules') || path.startsWith('/rule')) return Icons.shield_outlined;
    if (path.startsWith('/preference')) return Icons.psychology_outlined;
    if (path.startsWith('/project')) return Icons.rocket_launch_rounded;
    if (path.startsWith('/tools') || path.startsWith('/tool')) return Icons.construction_rounded;
    return Icons.folder_rounded;
  }

  Widget _buildDirectoryTreeView() {
    final effectiveTree = _filterTreeNodes(_coreMemoryTree, _treeFilterQuery);

    if (effectiveTree.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              _treeFilterQuery.isNotEmpty ? Icons.search_off_rounded : Icons.account_tree_outlined,
              size: 44,
              color: AuroraColors.fg3,
            ),
            const SizedBox(height: 12),
            Text(
              _treeFilterQuery.isNotEmpty
                  ? '未找到匹配「$_treeFilterQuery」的工程或准则'
                  : '当前分类下暂无树状记忆',
              style: const TextStyle(color: AuroraColors.fg2, fontSize: 14),
            ),
            if (_treeFilterQuery.isNotEmpty) ...[
              const SizedBox(height: 12),
              OutlinedButton.icon(
                icon: const Icon(Icons.clear, size: 14),
                label: const Text('清空过滤条件'),
                onPressed: () {
                  _treeFilterController.clear();
                  setState(() => _treeFilterQuery = '');
                },
              ),
            ] else ...[
              const SizedBox(height: 12),
              ElevatedButton.icon(
                icon: const Icon(Icons.add, size: 16),
                label: const Text('新增第一条长期记忆'),
                onPressed: () => _showAddOrEditMemoryDialog(),
              ),
            ],
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadCoreMemories,
      color: AuroraColors.accent,
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        itemCount: effectiveTree.length,
        itemBuilder: (context, index) {
          final node = effectiveTree[index] as Map<String, dynamic>;
          return _buildTreeNode(node, depth: 0);
        },
      ),
    );
  }

  Widget _buildTreeNode(Map<String, dynamic> node, {int depth = 0}) {
    final bool isFolder = node['is_folder'] == true;
    final path = node['tree_path']?.toString() ?? '';

    if (isFolder) {
      final title = node['title']?.toString() ?? path.split('/').last;
      final slug = node['name']?.toString() ?? path.split('/').last;
      final children = (node['children'] as List<dynamic>? ?? []);
      final leafCount = _countLeaves(node);
      final isExpanded = _expandedTreePaths.contains(path);
      final isRoot = depth == 0;
      final cat = node['category']?.toString() ?? path.replaceAll('/', '');
      final dimensionColor = _getCategoryColor(cat);

      if (isRoot) {
        // --- Level 0: Dimension Hero Card ---
        final rootIcon = _getDimensionIcon(path);
        return Container(
          margin: const EdgeInsets.only(top: 8, bottom: 4),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              colors: [
                dimensionColor.withValues(alpha: isExpanded ? 0.14 : 0.07),
                AuroraColors.surfaceSolid.withValues(alpha: 0.95),
              ],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: dimensionColor.withValues(alpha: isExpanded ? 0.45 : 0.2),
              width: 1,
            ),
            boxShadow: isExpanded
                ? [
                    BoxShadow(
                      color: dimensionColor.withValues(alpha: 0.12),
                      blurRadius: 12,
                      offset: const Offset(0, 3),
                    ),
                  ]
                : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              InkWell(
                onTap: () {
                  setState(() {
                    if (isExpanded) {
                      _expandedTreePaths.remove(path);
                    } else {
                      _expandedTreePaths.add(path);
                    }
                  });
                },
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  child: Row(
                    children: [
                      Container(
                        width: 32,
                        height: 32,
                        decoration: BoxDecoration(
                          color: dimensionColor.withValues(alpha: 0.2),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: dimensionColor.withValues(alpha: 0.4), width: 1),
                        ),
                        child: Icon(rootIcon, size: 18, color: dimensionColor),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              title,
                              style: const TextStyle(
                                fontSize: 14.5,
                                fontWeight: FontWeight.bold,
                                color: AuroraColors.fg1,
                                letterSpacing: -0.2,
                              ),
                            ),
                            Text(
                              path,
                              style: const TextStyle(fontSize: 10.5, color: AuroraColors.fg3, fontFamily: 'monospace'),
                            ),
                          ],
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: dimensionColor.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: dimensionColor.withValues(alpha: 0.3), width: 0.8),
                        ),
                        child: Text(
                          '$leafCount 条准则',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                            color: dimensionColor,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Icon(
                        isExpanded ? Icons.keyboard_arrow_down_rounded : Icons.keyboard_arrow_right_rounded,
                        size: 20,
                        color: AuroraColors.fg3,
                      ),
                    ],
                  ),
                ),
              ),
              if (isExpanded) ...[
                Padding(
                  padding: const EdgeInsets.only(left: 14, right: 10, bottom: 8),
                  child: Column(
                    children: [
                      for (final child in children)
                        if (child is Map<String, dynamic>)
                          _buildTreeNode(child, depth: depth + 1),
                    ],
                  ),
                ),
              ],
            ],
          ),
        );
      } else {
        // --- Level 1+: Subfolder / Project Card ---
        final isProjectFolder = path.startsWith('/project/');
        final projectIcon = isProjectFolder ? _getProjectIcon(slug) : (isExpanded ? Icons.folder_open_rounded : Icons.folder_rounded);
        final badgeColor = isProjectFolder ? _getProjectBadgeColor(slug) : AuroraColors.accent;

        return Container(
          margin: EdgeInsets.only(
            left: depth == 1 ? 4.0 : 16.0,
            top: 3,
            bottom: 3,
          ),
          decoration: BoxDecoration(
            border: Border(
              left: BorderSide(
                color: AuroraColors.borderStrong.withValues(alpha: 0.6),
                width: 1.5,
              ),
            ),
          ),
          child: Padding(
            padding: const EdgeInsets.only(left: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  decoration: BoxDecoration(
                    color: isExpanded ? AuroraColors.surface.withValues(alpha: 0.85) : Colors.transparent,
                    borderRadius: BorderRadius.circular(8),
                    border: isExpanded
                        ? Border.all(color: badgeColor.withValues(alpha: 0.3), width: 0.8)
                        : null,
                  ),
                  child: InkWell(
                    onTap: () {
                      setState(() {
                        if (isExpanded) {
                          _expandedTreePaths.remove(path);
                        } else {
                          _expandedTreePaths.add(path);
                        }
                      });
                    },
                    borderRadius: BorderRadius.circular(8),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                      child: Row(
                        children: [
                          Icon(projectIcon, size: 17, color: badgeColor),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    title,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: 13,
                                      fontWeight: isExpanded ? FontWeight.bold : FontWeight.w600,
                                      color: isExpanded ? AuroraColors.fg1 : AuroraColors.fg2,
                                    ),
                                  ),
                                ),
                                if (slug != title && slug.isNotEmpty) ...[
                                  const SizedBox(width: 6),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                                    decoration: BoxDecoration(
                                      color: AuroraColors.chip,
                                      borderRadius: BorderRadius.circular(4),
                                    ),
                                    child: Text(
                                      slug,
                                      style: const TextStyle(fontSize: 10, color: AuroraColors.fg3, fontFamily: 'monospace'),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                            decoration: BoxDecoration(
                              color: AuroraColors.surfaceSolid,
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: AuroraColors.border, width: 0.6),
                            ),
                            child: Text(
                              '$leafCount 条',
                              style: const TextStyle(fontSize: 10, color: AuroraColors.fg3),
                            ),
                          ),
                          const SizedBox(width: 4),
                          Icon(
                            isExpanded ? Icons.keyboard_arrow_down_rounded : Icons.keyboard_arrow_right_rounded,
                            size: 16,
                            color: AuroraColors.fg3,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                if (isExpanded) ...[
                  for (final child in children)
                    if (child is Map<String, dynamic>)
                      _buildTreeNode(child, depth: depth + 1),
                ],
              ],
            ),
          ),
        );
      }
    } else {
      // --- Leaf Node / Memory Entry Card ---
      final cat = node['category']?.toString() ?? 'general';
      final key = node['key']?.toString() ?? node['title']?.toString() ?? '';
      final content = node['content']?.toString() ?? '';
      final confidence = (node['confidence'] as num?)?.toDouble() ?? 1.0;
      final source = node['source']?.toString() ?? 'dreaming';
      final accentColor = _getCategoryColor(cat);

      return Container(
        margin: EdgeInsets.only(
          left: depth == 1 ? 4.0 : 16.0,
          top: 3,
          bottom: 5,
        ),
        decoration: BoxDecoration(
          border: Border(
            left: BorderSide(
              color: AuroraColors.borderStrong.withValues(alpha: 0.6),
              width: 1.5,
            ),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.only(left: 8),
          child: Container(
            decoration: BoxDecoration(
              color: AuroraColors.surfaceSolid,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: AuroraColors.border, width: 0.8),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // Left Accent Color Bar (3.5px)
                    Container(width: 3.5, color: accentColor),

                    // Main Memory Card Content
                    Expanded(
                      child: InkWell(
                        onTap: () => _showMemoryDetailModal(node),
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              // Top Bar: Key + Category + Source + Confidence
                              Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      key,
                                      style: const TextStyle(
                                        fontSize: 13,
                                        fontWeight: FontWeight.bold,
                                        color: AuroraColors.fg1,
                                      ),
                                    ),
                                  ),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
                                    decoration: BoxDecoration(
                                      color: accentColor.withValues(alpha: 0.15),
                                      borderRadius: BorderRadius.circular(4),
                                    ),
                                    child: Text(
                                      cat.toUpperCase(),
                                      style: TextStyle(
                                        fontSize: 9.5,
                                        fontWeight: FontWeight.bold,
                                        color: accentColor,
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 6),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
                                    decoration: BoxDecoration(
                                      color: AuroraColors.chip,
                                      borderRadius: BorderRadius.circular(4),
                                    ),
                                    child: Text(
                                      source == 'dreaming'
                                          ? '🌙 梦境'
                                          : (source == 'bootstrap' ? '🌟 自举' : '✍️ 手动'),
                                      style: const TextStyle(fontSize: 9.5, color: AuroraColors.fg3),
                                    ),
                                  ),
                                  const SizedBox(width: 6),
                                  Text(
                                    '${(confidence * 100).toInt()}% 置信',
                                    style: TextStyle(
                                      fontSize: 10,
                                      fontWeight: FontWeight.w600,
                                      color: confidence >= 0.9 ? const Color(0xFF10B981) : AuroraColors.fg3,
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 6),

                              // Content Text
                              Text(
                                content,
                                maxLines: 3,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 12.5,
                                  color: AuroraColors.fg1,
                                  height: 1.45,
                                ),
                              ),
                              const SizedBox(height: 8),

                              // Footer Row: Monospace Tree Path + Action Buttons
                              Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      path,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 10,
                                        color: AuroraColors.fg3,
                                        fontFamily: 'monospace',
                                      ),
                                    ),
                                  ),
                                  IconButton(
                                    icon: const Icon(Icons.copy_rounded, size: 14, color: AuroraColors.fg3),
                                    tooltip: '复制记忆路径',
                                    padding: EdgeInsets.zero,
                                    constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
                                    onPressed: () {
                                      Clipboard.setData(ClipboardData(text: path));
                                      ScaffoldMessenger.of(context).showSnackBar(
                                        SnackBar(
                                          content: Text('已复制: $path'),
                                          duration: const Duration(seconds: 1),
                                          behavior: SnackBarBehavior.floating,
                                        ),
                                      );
                                    },
                                  ),
                                  const SizedBox(width: 4),
                                  IconButton(
                                    icon: const Icon(Icons.edit_outlined, size: 14, color: AuroraColors.fg3),
                                    tooltip: '编辑',
                                    padding: EdgeInsets.zero,
                                    constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
                                    onPressed: () => _showAddOrEditMemoryDialog(existing: node),
                                  ),
                                  const SizedBox(width: 4),
                                  IconButton(
                                    icon: const Icon(Icons.delete_outline_rounded, size: 14, color: AuroraColors.danger),
                                    tooltip: '遗忘/删除',
                                    padding: EdgeInsets.zero,
                                    constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
                                    onPressed: () {
                                      if (node['id'] != null) {
                                        _deleteMemory(node['id'].toString());
                                      }
                                    },
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }
  }

  void _showMemoryDetailModal(Map<String, dynamic> mem) {
    final cat = mem['category']?.toString() ?? 'general';
    final key = mem['key']?.toString() ?? mem['title']?.toString() ?? '';
    final content = mem['content']?.toString() ?? '';
    final confidence = (mem['confidence'] as num?)?.toDouble() ?? 1.0;
    final source = mem['source']?.toString() ?? 'dreaming';
    final treePath = mem['tree_path']?.toString() ?? '';
    final updatedAt = (mem['updated_at']?.toString() ?? '').split('T').first;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AuroraColors.surfaceSolid,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) {
        return DraggableScrollableSheet(
          initialChildSize: 0.75,
          minChildSize: 0.4,
          maxChildSize: 0.95,
          expand: false,
          builder: (context, scrollController) {
            return ListView(
              controller: scrollController,
              padding: const EdgeInsets.all(20),
              children: [
                Center(
                  child: Container(
                    width: 36,
                    height: 4,
                    decoration: BoxDecoration(
                      color: AuroraColors.fg3.withValues(alpha: 0.4),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: _getCategoryColor(cat).withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        cat.toUpperCase(),
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.bold,
                          color: _getCategoryColor(cat),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                      decoration: BoxDecoration(
                        color: AuroraColors.chip,
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        source == 'dreaming'
                            ? '🌙 梦境萃取'
                            : (source == 'bootstrap' ? '🌟 知识自举' : '✍️ 手动录入'),
                        style: const TextStyle(fontSize: 11, color: AuroraColors.fg3),
                      ),
                    ),
                    const Spacer(),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: AuroraColors.accent.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        '置信度: ${(confidence * 100).toInt()}%',
                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AuroraColors.accent),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  key,
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                    color: AuroraColors.fg1,
                  ),
                ),
                if (treePath.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      const Icon(Icons.folder_open_outlined, size: 14, color: AuroraColors.fg3),
                      const SizedBox(width: 4),
                      Text(
                        treePath,
                        style: const TextStyle(fontSize: 12, color: AuroraColors.fg3, fontFamily: 'monospace'),
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 16),
                const Divider(color: AuroraColors.border, height: 1),
                const SizedBox(height: 16),
                AppMarkdown(data: content),
                const SizedBox(height: 24),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('更新于 $updatedAt', style: const TextStyle(fontSize: 12, color: AuroraColors.fg3)),
                    Row(
                      children: [
                        TextButton.icon(
                          icon: const Icon(Icons.edit_outlined, size: 16),
                          label: const Text('编辑'),
                          onPressed: () {
                            Navigator.pop(context);
                            _showAddOrEditMemoryDialog(existing: mem);
                          },
                        ),
                        const SizedBox(width: 8),
                        TextButton.icon(
                          icon: const Icon(Icons.delete_outline, size: 16, color: AuroraColors.danger),
                          label: const Text('遗忘/删除', style: TextStyle(color: AuroraColors.danger)),
                          onPressed: () {
                            Navigator.pop(context);
                            if (mem['id'] != null) {
                              _deleteMemory(mem['id'].toString());
                            }
                          },
                        ),
                      ],
                    ),
                  ],
                ),
              ],
            );
          },
        );
      },
    );
  }

  Widget _buildFlatListView() {
    if (_coreMemories.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.lightbulb_outline, size: 40, color: AuroraColors.fg3),
            const SizedBox(height: 12),
            const Text(
              '当前分类下暂无核心记忆',
              style: TextStyle(color: AuroraColors.fg3, fontSize: 14),
            ),
            const SizedBox(height: 12),
            ElevatedButton.icon(
              icon: const Icon(Icons.add, size: 16),
              label: const Text('新增第一条长期记忆'),
              onPressed: () => _showAddOrEditMemoryDialog(),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadCoreMemories,
      color: AuroraColors.accent,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _coreMemories.length,
        itemBuilder: (context, index) {
          final mem = _coreMemories[index] as Map<String, dynamic>;
          final cat = mem['category']?.toString() ?? 'general';
          final key = mem['key']?.toString() ?? '';
          final content = mem['content']?.toString() ?? '';
          final confidence = (mem['confidence'] as num?)?.toDouble() ?? 1.0;
          final source = mem['source']?.toString() ?? 'dreaming';

          return Container(
            margin: const EdgeInsets.only(bottom: 12),
            child: InkWell(
              onTap: () => _showMemoryDetailModal(mem),
              borderRadius: BorderRadius.circular(12),
              child: GlassCard(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: _getCategoryColor(cat).withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            cat.toUpperCase(),
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.bold,
                              color: _getCategoryColor(cat),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            key,
                            style: const TextStyle(
                              fontSize: 13.5,
                              fontWeight: FontWeight.bold,
                              color: AuroraColors.fg1,
                            ),
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                          decoration: BoxDecoration(
                            color: AuroraColors.chip,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            source == 'dreaming'
                                ? '🌙 梦境萃取'
                                : (source == 'bootstrap' ? '🌟 知识自举' : '✍️ 手动'),
                            style: const TextStyle(fontSize: 10, color: AuroraColors.fg3),
                          ),
                        ),
                        PopupMenuButton<String>(
                          icon: const Icon(Icons.more_vert, size: 18, color: AuroraColors.fg3),
                          color: AuroraColors.surfaceSolid,
                          onSelected: (action) {
                            if (action == 'edit') {
                              _showAddOrEditMemoryDialog(existing: mem);
                            } else if (action == 'delete') {
                              _deleteMemory(mem['id'].toString());
                            }
                          },
                          itemBuilder: (ctx) => const [
                            PopupMenuItem(value: 'edit', child: Text('编辑')),
                            PopupMenuItem(value: 'delete', child: Text('遗忘/删除', style: TextStyle(color: AuroraColors.danger))),
                          ],
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      content,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 13,
                        color: AuroraColors.fg1,
                        height: 1.45,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          '置信度: ${(confidence * 100).toInt()}%',
                          style: const TextStyle(fontSize: 11, color: AuroraColors.fg3),
                        ),
                        Text(
                          (mem['updated_at']?.toString() ?? '').split('T').first,
                          style: const TextStyle(fontSize: 11, color: AuroraColors.fg3),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }


  // --- View: Tab 3 (Dreaming & Memory Tiers) ---
  Widget _buildDreamingTab() {
    return RefreshIndicator(
      onRefresh: _loadDreamData,
      color: AuroraColors.accent,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Dreaming Control Hero Card
          GlassCard(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Row(
                  children: [
                    Icon(Icons.nights_stay, color: AuroraColors.accent, size: 20),
                    SizedBox(width: 8),
                    Text(
                      '自主做梦机制 (Dreaming Consolidation)',
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.bold,
                        color: AuroraColors.fg1,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                const Text(
                  '系统每日夜间 (03:00) 或空闲时自动唤醒，模拟生物睡眠三阶段（浅睡去噪 -> REM 联想反思 -> 深睡固化与衰减），将每日海量琐事蒸馏为长期开发铁律。',
                  style: TextStyle(fontSize: 12.5, color: AuroraColors.fg2, height: 1.45),
                ),
                const SizedBox(height: 14),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton.icon(
                    onPressed: _isDreamingRunning ? null : _showDreamScopeDialog,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AuroraColors.accent,
                      foregroundColor: Colors.black,
                      padding: const EdgeInsets.symmetric(vertical: 12),
                    ),
                    icon: _isDreamingRunning
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black),
                          )
                        : const Icon(Icons.bedtime_outlined, size: 18),
                    label: Text(_isDreamingRunning ? '正在做梦反思与记忆重组...' : '唤醒做梦与历史沉淀 (Trigger Dream)'),
                  ),
                ),
                const SizedBox(height: 8),
                const Center(
                  child: Text(
                    '💡 提示：若需沉淀历史全部 18+ 核心项目，请点击按钮选择「全历史全景做梦」或「全量自举」',
                    style: TextStyle(fontSize: 11, color: AuroraColors.fg3),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // 3-Tier Memory Architecture Overview Cards
          if (_tierStats != null) ...[
            const Text(
              '三层记忆金字塔状态',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: AuroraColors.fg1),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: _buildTierCard(
                    'L1 工作记忆',
                    '${_tierStats!['l1_working']?['conversations'] ?? 0}',
                    '实时交互轮次',
                    AuroraColors.chip,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _buildTierCard(
                    'L2 情景记忆',
                    '${_tierStats!['l2_episodic']?['daily_summaries'] ?? 0}',
                    '每日研发小结',
                    AuroraColors.chip,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _buildTierCard(
                    'L3 核心记忆',
                    '${_tierStats!['l3_core']?['core_memories'] ?? 0}',
                    'MEMORY.md 准则',
                    AuroraColors.accent.withValues(alpha: 0.18),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
          ],

          if (_dreamError != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: Text(_dreamError!, style: const TextStyle(color: AuroraColors.danger, fontSize: 13)),
            ),

          // Historical Dream Journals
          const Row(
            children: [
              Icon(Icons.auto_stories, size: 16, color: AuroraColors.accent),
              SizedBox(width: 6),
              Text(
                '梦境日记 (Dream Journals)',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: AuroraColors.fg1),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (_isDreamLoading)
            const AuroraListSkeleton(count: 2)
          else if (_dreamJournals.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: Center(
                child: Text(
                  '暂无梦境日记。点击上方“立即唤醒做梦”可体验夜间沉淀流程。',
                  style: TextStyle(color: AuroraColors.fg3, fontSize: 13),
                ),
              ),
            )
          else
            ..._dreamJournals.map((j) {
              final journal = j as Map<String, dynamic>;
              final dateStr = journal['dream_date']?.toString() ?? '';
              final metrics = journal['stage_metrics'] as Map<String, dynamic>? ?? {};
              final scanned = metrics['scanned_items'] ?? 0;
              final promoted = metrics['promoted_count'] ?? 0;
              final snippet = journal['summary_snippet']?.toString() ?? '';

              return Container(
                margin: const EdgeInsets.only(bottom: 10),
                child: GlassCard(
                  padding: const EdgeInsets.all(14),
                  onTap: () => _showDreamJournalDetail(journal['id'].toString()),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Row(
                            children: [
                              const Icon(Icons.dark_mode_outlined, size: 16, color: AuroraColors.accent),
                              const SizedBox(width: 6),
                              Text(
                                dateStr,
                                style: const TextStyle(
                                  fontSize: 13.5,
                                  fontWeight: FontWeight.bold,
                                  color: AuroraColors.fg1,
                                ),
                              ),
                            ],
                          ),
                          Text(
                            '扫描 $scanned 项 · 晋升 $promoted 条',
                            style: const TextStyle(fontSize: 11.5, color: AuroraColors.accent),
                          ),
                        ],
                      ),
                      if (snippet.isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Text(
                          snippet,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12, color: AuroraColors.fg2, height: 1.4),
                        ),
                      ],
                    ],
                  ),
                ),
              );
            }),
        ],
      ),
    );
  }

  Widget _buildTierCard(String title, String count, String subtitle, Color bgColor) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AuroraColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontSize: 11, color: AuroraColors.fg3)),
          const SizedBox(height: 4),
          Text(
            count,
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: AuroraColors.fg1),
          ),
          const SizedBox(height: 2),
          Text(subtitle, style: const TextStyle(fontSize: 10, color: AuroraColors.fg2)),
        ],
      ),
    );
  }
}
