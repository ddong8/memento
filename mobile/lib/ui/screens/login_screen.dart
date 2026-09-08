import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/theme/aurora_theme.dart';
import '../../state/auth_state.dart';
import '../widgets/glass_card.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  final _serverController = TextEditingController();

  bool _showServerConfig = false;

  @override
  void initState() {
    super.initState();
    final auth = ref.read(authProvider);
    _serverController.text = auth.serverUrl;
  }

  @override
  void dispose() {
    _usernameController.dispose();
    _passwordController.dispose();
    _serverController.dispose();
    super.dispose();
  }

  void _handleLogin() async {
    final username = _usernameController.text.trim();
    final password = _passwordController.text.trim();
    if (username.isEmpty || password.isEmpty) return;

    if (_showServerConfig) {
      await ref
          .read(authProvider.notifier)
          .updateServerUrl(_serverController.text.trim());
    }

    await ref.read(authProvider.notifier).login(username, password);
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authProvider);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                // Logo & Title
                Container(
                  width: 64,
                  height: 64,
                  decoration: BoxDecoration(
                    gradient: AuroraColors.brandGradient,
                    borderRadius: BorderRadius.circular(20),
                    boxShadow: [
                      BoxShadow(
                        color: AuroraColors.accent.withOpacity(0.35),
                        blurRadius: 20,
                        offset: const Offset(0, 6),
                      ),
                    ],
                  ),
                  child: const Icon(
                    Icons.psychology,
                    size: 36,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 18),
                const Text(
                  'Memento',
                  style: TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.bold,
                    letterSpacing: -0.8,
                    color: AuroraColors.fg1,
                  ),
                ),
                const SizedBox(height: 6),
                const Text(
                  '跨设备 AI 编程记忆与远程协同控制',
                  style: TextStyle(
                    fontSize: 13.5,
                    color: AuroraColors.fg2,
                  ),
                ),
                const SizedBox(height: 32),

                // Form Glass Card
                GlassCard(
                  padding: const EdgeInsets.all(22),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // Server URL toggle & field
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text(
                            '服务器配置',
                            style: TextStyle(
                              fontSize: 12.5,
                              fontWeight: FontWeight.w600,
                              color: AuroraColors.fg2,
                            ),
                          ),
                          TextButton(
                            onPressed: () {
                              setState(() => _showServerConfig = !_showServerConfig);
                            },
                            style: TextButton.styleFrom(
                              padding: EdgeInsets.zero,
                              minimumSize: Size.zero,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                            child: Text(
                              _showServerConfig ? '隐藏' : '自定义节点',
                              style: const TextStyle(
                                fontSize: 12,
                                color: AuroraColors.accent,
                              ),
                            ),
                          ),
                        ],
                      ),
                      if (_showServerConfig) ...[
                        const SizedBox(height: 8),
                        TextField(
                          controller: _serverController,
                          style: const TextStyle(color: AuroraColors.fg1, fontSize: 13),
                          decoration: const InputDecoration(
                            hintText: '如 https://mem.ihasy.com',
                            prefixIcon: Icon(Icons.dns_outlined, size: 18, color: AuroraColors.fg3),
                          ),
                        ),
                      ],
                      const SizedBox(height: 16),

                      // Username field
                      const Text(
                        '用户名',
                        style: TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w600,
                          color: AuroraColors.fg2,
                        ),
                      ),
                      const SizedBox(height: 6),
                      TextField(
                        controller: _usernameController,
                        style: const TextStyle(color: AuroraColors.fg1, fontSize: 14),
                        decoration: const InputDecoration(
                          hintText: '请输入用户名',
                          prefixIcon: Icon(Icons.person_outline, size: 18, color: AuroraColors.fg3),
                        ),
                      ),
                      const SizedBox(height: 14),

                      // Password field
                      const Text(
                        '密码',
                        style: TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w600,
                          color: AuroraColors.fg2,
                        ),
                      ),
                      const SizedBox(height: 6),
                      TextField(
                        controller: _passwordController,
                        obscureText: true,
                        style: const TextStyle(color: AuroraColors.fg1, fontSize: 14),
                        decoration: const InputDecoration(
                          hintText: '请输入登录密码',
                          prefixIcon: Icon(Icons.lock_outline, size: 18, color: AuroraColors.fg3),
                        ),
                        onSubmitted: (_) => _handleLogin(),
                      ),
                      const SizedBox(height: 20),

                      // Error message if any
                      if (authState.errorMessage != null) ...[
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                          margin: const EdgeInsets.only(bottom: 14),
                          decoration: BoxDecoration(
                            color: AuroraColors.dangerSoft,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: AuroraColors.danger.withOpacity(0.3)),
                          ),
                          child: Text(
                            authState.errorMessage!,
                            style: const TextStyle(
                              color: AuroraColors.danger,
                              fontSize: 12.5,
                            ),
                          ),
                        ),
                      ],

                      // Login button
                      SizedBox(
                        height: 46,
                        child: ElevatedButton(
                          onPressed: authState.isLoading ? null : _handleLogin,
                          child: authState.isLoading
                              ? const SizedBox(
                                  width: 20,
                                  height: 20,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.black,
                                  ),
                                )
                              : const Text('进入 Memento'),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
