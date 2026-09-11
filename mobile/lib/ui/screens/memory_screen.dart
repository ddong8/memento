import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/theme/aurora_theme.dart';
import '../../models/search_hit.dart';
import '../widgets/glass_card.dart';
import '../widgets/app_markdown.dart';

class MemoryScreen extends StatefulWidget {
  const MemoryScreen({super.key});

  @override
  State<MemoryScreen> createState() => _MemoryScreenState();
}

class _MemoryScreenState extends State<MemoryScreen> {
  final _searchController = TextEditingController();
  bool _semantic = true;
  bool _isLoading = false;
  List<SearchHit> _hits = [];
  String? _error;

  void _doSearch() async {
    final query = _searchController.text.trim();
    if (query.isEmpty) return;

    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final res = await ApiClient().searchMemory(query, semantic: _semantic);
      final rawResults = res['results'] as List<dynamic>? ?? [];
      setState(() {
        _hits = rawResults.map((j) => SearchHit.fromJson(j)).toList();
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _error = '检索出错: $e';
        _isLoading = false;
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
                          color: AuroraColors.fg3.withOpacity(0.4),
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
                          color: AuroraColors.accentSoft,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: AuroraColors.accent.withOpacity(0.3)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Row(
                              children: [
                                Icon(Icons.auto_awesome, size: 14, color: AuroraColors.accent),
                                SizedBox(width: 6),
                                Text(
                                  'AI 智能归纳',
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
                              style: const TextStyle(fontSize: 12.5, color: AuroraColors.fg1, height: 1.4),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                    ],
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('记忆检索'),
      ),
      body: Column(
        children: [
          // Search input bar
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _searchController,
                    style: const TextStyle(color: AuroraColors.fg1, fontSize: 14),
                    decoration: InputDecoration(
                      hintText: '搜索跨设备对话、代码与计划...',
                      prefixIcon: const Icon(Icons.search, size: 18, color: AuroraColors.fg3),
                      suffixIcon: IconButton(
                        icon: Icon(
                          Icons.psychology,
                          color: _semantic ? AuroraColors.accent : AuroraColors.fg3,
                          size: 20,
                        ),
                        tooltip: _semantic ? '语义检索开启' : '普通关键词匹配',
                        onPressed: () {
                          setState(() => _semantic = !_semantic);
                        },
                      ),
                    ),
                    onSubmitted: (_) => _doSearch(),
                  ),
                ),
                const SizedBox(width: 10),
                ElevatedButton(
                  onPressed: _isLoading ? null : _doSearch,
                  style: ElevatedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  ),
                  child: _isLoading
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

          if (_error != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(_error!, style: const TextStyle(color: AuroraColors.danger, fontSize: 13)),
            ),

          // Hits list
          Expanded(
            child: _hits.isEmpty && !_isLoading
                ? const Center(
                    child: Text(
                      '输入关键词检索跨设备的编程记忆',
                      style: TextStyle(color: AuroraColors.fg3, fontSize: 13.5),
                    ),
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
                                      style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: AuroraColors.accent),
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
      ),
    );
  }
}
