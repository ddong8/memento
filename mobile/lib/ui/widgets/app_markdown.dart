import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_highlight/themes/atom-one-dark.dart';
import 'package:highlight/highlight.dart' as hl;
import '../../core/theme/aurora_theme.dart';

class AppSyntaxHighlighter extends SyntaxHighlighter {
  final Map<String, TextStyle> theme;

  AppSyntaxHighlighter({this.theme = atomOneDarkTheme});

  @override
  TextSpan format(String source) {
    try {
      final result = hl.highlight.parse(source, autoDetection: true);
      if (result.nodes != null) {
        return TextSpan(
          style: const TextStyle(
            fontFamily: 'monospace',
            fontSize: 12.5,
            height: 1.5,
          ),
          children: _convert(result.nodes!),
        );
      }
    } catch (_) {}

    return TextSpan(
      style: const TextStyle(
        fontFamily: 'monospace',
        fontSize: 12.5,
        color: Color(0xFFE2E8F0),
        height: 1.5,
      ),
      text: source,
    );
  }

  List<TextSpan> _convert(List<hl.Node> nodes) {
    final List<TextSpan> spans = [];
    var currentSpans = spans;
    final List<List<TextSpan>> stack = [];

    void traverse(hl.Node node) {
      if (node.value != null) {
        currentSpans.add(node.className == null
            ? TextSpan(text: node.value)
            : TextSpan(text: node.value, style: theme[node.className!]));
      } else if (node.children != null) {
        final List<TextSpan> tmp = [];
        currentSpans.add(TextSpan(children: tmp, style: theme[node.className!]));
        stack.add(currentSpans);
        currentSpans = tmp;

        for (final n in node.children!) {
          traverse(n);
          if (n == node.children!.last) {
            currentSpans = stack.isEmpty ? spans : stack.removeLast();
          }
        }
      }
    }

    for (final node in nodes) {
      traverse(node);
    }
    return spans;
  }
}

class AppMarkdown extends StatelessWidget {
  final String data;
  final bool selectable;
  final TextStyle? baseTextStyle;

  const AppMarkdown({
    super.key,
    required this.data,
    this.selectable = true,
    this.baseTextStyle,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final pStyle = baseTextStyle ??
        const TextStyle(
          fontSize: 14,
          color: AuroraColors.fg1,
          height: 1.6,
          letterSpacing: 0.1,
        );

    final styleSheet = MarkdownStyleSheet.fromTheme(theme).copyWith(
      p: pStyle,
      pPadding: const EdgeInsets.only(bottom: 6),
      h1: const TextStyle(
        fontSize: 19,
        fontWeight: FontWeight.w700,
        color: AuroraColors.fg1,
        height: 1.4,
      ),
      h1Padding: const EdgeInsets.only(top: 14, bottom: 6),
      h2: const TextStyle(
        fontSize: 16.5,
        fontWeight: FontWeight.w700,
        color: AuroraColors.fg1,
        height: 1.4,
      ),
      h2Padding: const EdgeInsets.only(top: 12, bottom: 5),
      h3: const TextStyle(
        fontSize: 15,
        fontWeight: FontWeight.w600,
        color: AuroraColors.fg1,
        height: 1.4,
      ),
      h3Padding: const EdgeInsets.only(top: 10, bottom: 4),
      h4: const TextStyle(
        fontSize: 14,
        fontWeight: FontWeight.w600,
        color: AuroraColors.fg1,
      ),
      h4Padding: const EdgeInsets.only(top: 8, bottom: 3),
      strong: const TextStyle(
        fontWeight: FontWeight.w700,
        color: AuroraColors.fg1,
      ),
      em: const TextStyle(
        fontStyle: FontStyle.italic,
        color: AuroraColors.fg2,
      ),
      code: const TextStyle(
        fontFamily: 'monospace',
        fontSize: 12.5,
        color: AuroraColors.accent,
        backgroundColor: Color(0x1F38BDF8),
      ),
      codeblockPadding: const EdgeInsets.all(12),
      codeblockDecoration: BoxDecoration(
        color: const Color(0xFF090D16),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AuroraColors.borderStrong),
      ),
      blockquote: const TextStyle(
        fontSize: 13.5,
        color: AuroraColors.fg2,
        fontStyle: FontStyle.italic,
        height: 1.5,
      ),
      blockquotePadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      blockquoteDecoration: const BoxDecoration(
        color: Color(0x1038BDF8),
        border: Border(
          left: BorderSide(color: AuroraColors.accent, width: 3),
        ),
      ),
      listBullet: const TextStyle(
        fontSize: 14,
        color: AuroraColors.accent,
        fontWeight: FontWeight.bold,
      ),
      listBulletPadding: const EdgeInsets.only(right: 6),
      tableBorder: TableBorder.all(
        color: AuroraColors.borderStrong,
        width: 1,
      ),
      tableHead: const TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w700,
        color: AuroraColors.fg1,
      ),
      tableBody: const TextStyle(
        fontSize: 12.5,
        color: AuroraColors.fg2,
      ),
      tableCellsPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      tableCellsDecoration: const BoxDecoration(
        color: Color(0xFF0F172A),
      ),
      horizontalRuleDecoration: const BoxDecoration(
        border: Border(
          top: BorderSide(color: AuroraColors.borderStrong, width: 1),
        ),
      ),
    );

    return MarkdownBody(
      data: data,
      selectable: selectable,
      softLineBreak: true,
      styleSheet: styleSheet,
      syntaxHighlighter: AppSyntaxHighlighter(),
    );
  }
}
