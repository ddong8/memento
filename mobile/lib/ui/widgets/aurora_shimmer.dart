import 'package:flutter/material.dart';
import '../../core/theme/aurora_theme.dart';

/// Aurora Shimmer Skeleton Loading Widget.
/// Provides smooth, 60fps glowing skeleton placeholders without external dependencies.
class AuroraShimmerBox extends StatefulWidget {
  final double? width;
  final double? height;
  final double borderRadius;
  final EdgeInsetsGeometry? margin;

  const AuroraShimmerBox({
    super.key,
    this.width,
    this.height,
    this.borderRadius = 10,
    this.margin,
  });

  @override
  State<AuroraShimmerBox> createState() => _AuroraShimmerBoxState();
}

class _AuroraShimmerBoxState extends State<AuroraShimmerBox>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        final v = _controller.value;
        return Container(
          width: widget.width,
          height: widget.height,
          margin: widget.margin,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(widget.borderRadius),
            border: Border.all(color: AuroraColors.border, width: 1),
            gradient: LinearGradient(
              begin: Alignment(v * 3.0 - 2.0, -0.2),
              end: Alignment(v * 3.0 - 0.5, 0.2),
              colors: const [
                AuroraColors.surface,
                AuroraColors.surfaceElevated,
                AuroraColors.surface,
              ],
              stops: const [0.0, 0.5, 1.0],
            ),
          ),
        );
      },
    );
  }
}

/// Ready-to-use list skeleton matching Aurora Card layouts.
class AuroraListSkeleton extends StatelessWidget {
  final int count;
  final double itemHeight;

  const AuroraListSkeleton({
    super.key,
    this.count = 4,
    this.itemHeight = 76,
  });

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      physics: const NeverScrollableScrollPhysics(),
      shrinkWrap: true,
      itemCount: count,
      itemBuilder: (context, index) {
        return Container(
          height: itemHeight,
          margin: const EdgeInsets.only(bottom: 12),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          decoration: BoxDecoration(
            color: AuroraColors.surfaceSolid,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AuroraColors.border),
          ),
          child: Row(
            children: [
              const AuroraShimmerBox(
                width: 42,
                height: 42,
                borderRadius: 12,
              ),
              const SizedBox(width: 14),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    AuroraShimmerBox(
                      width: double.infinity,
                      height: 14,
                      borderRadius: 6,
                    ),
                    SizedBox(height: 8),
                    AuroraShimmerBox(
                      width: 140,
                      height: 11,
                      borderRadius: 5,
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
