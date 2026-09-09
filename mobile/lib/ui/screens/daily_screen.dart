import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../../core/api_client.dart';
import '../../core/theme/aurora_theme.dart';
import '../../models/daily_summary.dart';
import '../widgets/glass_card.dart';

class DailyScreen extends StatefulWidget {
  const DailyScreen({super.key});

  @override
  State<DailyScreen> createState() => _DailyScreenState();
}

class _DailyScreenState extends State<DailyScreen> {
  bool _isLoading = true;
  List<DailyDate> _dates = [];
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadDates();
  }

  Future<void> _loadDates() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final rawList = await ApiClient().getDailyDates();
      final list = rawList.map((j) => DailyDate.fromJson(j)).toList();
      setState(() {
        _dates = list;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _error = '加载工作总结列表失败: $e';
        _isLoading = false;
      });
    }
  }

  void _showDailyDetail(String date) async {
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
              future: ApiClient().getDailyDetail(date),
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator(color: AuroraColors.accent));
                }
                if (snapshot.hasError || !snapshot.hasData) {
                  return const Center(child: Text('加载详情失败', style: TextStyle(color: AuroraColors.danger)));
                }

                final detail = DailyDetail.fromJson(snapshot.data!);

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
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Expanded(
                          child: Text(
                            '📅 $date 工作总结',
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.bold,
                              color: AuroraColors.fg1,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          '共 ${detail.totalDocuments} 篇记录',
                          style: const TextStyle(fontSize: 12, color: AuroraColors.fg3),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    if (detail.summaries.isEmpty)
                      const Center(
                        child: Padding(
                          padding: EdgeInsets.all(32),
                          child: Text('本日暂无 AI 归纳总结', style: TextStyle(color: AuroraColors.fg3)),
                        ),
                      )
                    else
                      ...detail.summaries.map(
                        (s) => Container(
                          margin: const EdgeInsets.only(bottom: 16),
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(
                            color: AuroraColors.chip,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: AuroraColors.border),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                s.title,
                                style: const TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.bold,
                                  color: AuroraColors.accent,
                                ),
                              ),
                              const SizedBox(height: 8),
                              MarkdownBody(
                                data: s.summary,
                                styleSheet: MarkdownStyleSheet(
                                  p: const TextStyle(color: AuroraColors.fg1, fontSize: 13.5, height: 1.5),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
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
        title: const Text('工作总结'),
      ),
      body: RefreshIndicator(
        onRefresh: _loadDates,
        color: AuroraColors.accent,
        child: _isLoading
            ? const Center(child: CircularProgressIndicator(color: AuroraColors.accent))
            : _error != null
                ? Center(child: Text(_error!, style: const TextStyle(color: AuroraColors.danger)))
                : _dates.isEmpty
                    ? const Center(
                        child: Text(
                          '暂无每日工作总结记录',
                          style: TextStyle(color: AuroraColors.fg3),
                        ),
                      )
                    : ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _dates.length,
                        itemBuilder: (context, index) {
                          final item = _dates[index];
                          return Container(
                            margin: const EdgeInsets.only(bottom: 12),
                            child: GlassCard(
                              padding: const EdgeInsets.all(16),
                              onTap: () => _showDailyDetail(item.date),
                              child: Row(
                                children: [
                                  Container(
                                    width: 40,
                                    height: 40,
                                    decoration: BoxDecoration(
                                      color: AuroraColors.accentSoft,
                                      borderRadius: BorderRadius.circular(10),
                                    ),
                                    child: const Icon(
                                      Icons.calendar_month,
                                      color: AuroraColors.accent,
                                      size: 22,
                                    ),
                                  ),
                                  const SizedBox(width: 14),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          item.date,
                                          style: const TextStyle(
                                            fontSize: 15,
                                            fontWeight: FontWeight.bold,
                                            color: AuroraColors.fg1,
                                          ),
                                        ),
                                        const SizedBox(height: 4),
                                        Text(
                                          '收录 ${item.documentCount} 条开发记录',
                                          style: const TextStyle(
                                            fontSize: 12,
                                            color: AuroraColors.fg3,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  const Icon(
                                    Icons.chevron_right,
                                    color: AuroraColors.fg3,
                                    size: 20,
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
      ),
    );
  }
}
