class SearchHit {
  final String id;
  final String toolId;
  final String relativePath;
  final String category;
  final String? title;
  final String snippet;
  final String syncedAt;
  final bool matchedSemantically;

  SearchHit({
    required this.id,
    required this.toolId,
    required this.relativePath,
    required this.category,
    this.title,
    required this.snippet,
    required this.syncedAt,
    this.matchedSemantically = false,
  });

  factory SearchHit.fromJson(Map<String, dynamic> json) {
    return SearchHit(
      id: json['id']?.toString() ?? '',
      toolId: json['tool_id']?.toString() ?? '',
      relativePath: json['relative_path']?.toString() ?? '',
      category: json['category']?.toString() ?? '',
      title: json['title']?.toString(),
      snippet: json['snippet']?.toString() ?? '',
      syncedAt: json['synced_at']?.toString() ?? '',
      matchedSemantically: json['matched_semantically'] == true,
    );
  }
}
