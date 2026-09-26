import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:memento_mobile/core/sse_client.dart';
import 'package:memento_mobile/core/storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Records what the client sent and lets each test script the server's replies.
class _FakeServer {
  late HttpServer server;
  final posts = <Map<String, dynamic>>[];
  final gets = <Uri>[];
  final cancels = <String>[];
  late Future<void> Function(HttpRequest req, int n) onPost;
  Future<void> Function(HttpRequest req, int n)? onAttach;

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    await AppStorage.setServerUrl('http://127.0.0.1:${server.port}');
    server.listen((req) async {
      final path = req.uri.path;
      if (req.method == 'POST' && path == '/api/ask') {
        posts.add(jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, dynamic>);
        await onPost(req, posts.length);
      } else if (req.method == 'GET' && path.endsWith('/stream')) {
        gets.add(req.uri);
        await onAttach!(req, gets.length);
      } else if (req.method == 'POST' && path.endsWith('/cancel')) {
        cancels.add(path);
        req.response.write('{"status":"cancelling"}');
        await req.response.close();
      } else {
        req.response.statusCode = 404;
        await req.response.close();
      }
    });
  }

  static void sse(HttpRequest req) {
    req.response.bufferOutput = false;
    req.response.headers.contentType = ContentType('text', 'event-stream');
  }

  static Future<void> drop(HttpRequest req) async {
    await req.response.flush();
    final socket = await req.response.detachSocket();
    socket.destroy();
  }

  /// Send [frames] and then cut the connection mid-stream, like a phone
  /// suspending in the background.
  static Future<void> dropAfter(HttpRequest req, String frames) async {
    req.response.headers.contentType = ContentType('text', 'event-stream');
    req.response.headers.chunkedTransferEncoding = false;
    final socket = await req.response.detachSocket();
    socket.write(frames);
    await socket.flush();
    socket.destroy();
  }
}

class _Recorder {
  final deltas = <String>[];
  final errors = <String>[];
  var runGone = false;
  final done = Completer<void>();

  AskStreamHandlers get handlers => AskStreamHandlers(
        onConversationId: (_, __) {},
        onSources: (_) {},
        onToolCall: (_) {},
        onTaskProgress: (_, __, ___, ____) {},
        onTaskChunk: (_, __, ___, ____, _____) {},
        onToolResult: (_, __, ___) {},
        onThinking: (_) {},
        onDelta: deltas.add,
        onError: errors.add,
        onRunGone: () => runGone = true,
        onDone: () => done.complete(),
      );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;

  late _FakeServer fake;
  final clients = <AskSseClient>[];
  AskSseClient newClient({Duration idle = const Duration(seconds: 30)}) {
    final c = AskSseClient(idleTimeout: idle);
    clients.add(c);
    return c;
  }

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    fake = _FakeServer();
    await fake.start();
  });

  tearDown(() async {
    for (final c in clients) {
      c.detach();
    }
    clients.clear();
    await fake.server.close(force: true);
  });

  test('ignores keepalive comments and receives deltas', () async {
    fake.onPost = (req, _) async {
      _FakeServer.sse(req);
      req.response.write(': keepalive\n\n');
      req.response.write('id: 1\ndata: {"type": "delta", "text": "Hello world"}\n\n');
      req.response.write('id: 2\ndata: {"type": "done"}\n\n');
      await req.response.close();
    };
    final rec = _Recorder();
    await newClient().ask(question: 'ping', handlers: rec.handlers);
    await rec.done.future;
    expect(rec.deltas, ['Hello world']);
    expect(rec.errors, isEmpty);
  });

  test('retries a send that dropped before the run started, with the same request id', () async {
    fake.onPost = (req, n) async {
      _FakeServer.sse(req);
      if (n == 1) return _FakeServer.drop(req);
      req.response.write('data: {"type": "delta", "text": "Recovered"}\n\n');
      req.response.write('data: {"type": "done"}\n\n');
      await req.response.close();
    };
    final rec = _Recorder();
    await newClient().ask(question: 'retry', handlers: rec.handlers);
    await rec.done.future;
    expect(fake.posts, hasLength(2));
    expect(fake.posts[0]['request_id'], isNotEmpty);
    expect(fake.posts[1]['request_id'], fake.posts[0]['request_id']);
    expect(rec.deltas, ['Recovered']);
  });

  test('once the run started, a dropped connection reattaches instead of resending', () async {
    fake.onPost = (req, _) => _FakeServer.dropAfter(
          req,
          'id: 1\ndata: {"type": "run_started"}\n\n'
          'id: 2\ndata: {"type": "conversation_id", "id": "conv-1"}\n\n'
          'id: 3\ndata: {"type": "delta", "text": "part 1 "}\n\n',
        );
    fake.onAttach = (req, _) async {
      _FakeServer.sse(req);
      req.response.write('id: 4\ndata: {"type": "delta", "text": "part 2"}\n\n');
      req.response.write('id: 5\ndata: {"type": "done"}\n\n');
      await req.response.close();
    };
    final rec = _Recorder();
    await newClient().ask(question: 'long task', handlers: rec.handlers);
    await rec.done.future;

    expect(fake.posts, hasLength(1)); // never dispatched twice
    expect(fake.gets.single.path, '/api/ask/conversations/conv-1/stream');
    expect(fake.gets.single.queryParameters['after'], '3');
    expect(rec.deltas.join(), 'part 1 part 2');
    expect(rec.errors, isEmpty);
  });

  test('a run that is gone from the server hands over to the saved conversation', () async {
    fake.onAttach = (req, _) async {
      req.response.statusCode = 404;
      await req.response.close();
    };
    final rec = _Recorder();
    await newClient().attach(conversationId: 'conv-2', after: 7, handlers: rec.handlers);
    await rec.done.future;
    expect(fake.gets.single.queryParameters['after'], '7');
    expect(rec.runGone, isTrue);
  });

  test('stop cancels the run on the server', () async {
    fake.onAttach = (req, _) async {
      _FakeServer.sse(req);
      req.response.write('id: 1\ndata: {"type": "delta", "text": "working"}\n\n');
      await req.response.flush(); // stays open, like a long-running run
    };
    final rec = _Recorder();
    final client = newClient();
    unawaited(client.attach(conversationId: 'conv-3', handlers: rec.handlers));
    for (var i = 0; rec.deltas.isEmpty && i < 200; i++) {
      await Future.delayed(const Duration(milliseconds: 10));
    }
    expect(rec.deltas, ['working']);
    await client.stop(null);
    await rec.done.future;
    expect(fake.cancels, ['/api/ask/conversations/conv-3/cancel']);
    expect(client.isFollowing, isFalse);
  });

  test('friendly error when every send attempt drops before the run starts', () async {
    fake.onPost = (req, _) async {
      _FakeServer.sse(req);
      await _FakeServer.drop(req);
    };
    final rec = _Recorder();
    await newClient().ask(question: 'fail', handlers: rec.handlers);
    await rec.done.future;
    expect(rec.errors.single, contains('服务器连接中断'));
    expect(fake.posts, hasLength(3));
  });

  test('a follow-up send that never reached the server errors instead of reattaching', () async {
    fake.onPost = (req, _) async {
      _FakeServer.sse(req);
      await _FakeServer.drop(req);
    };
    fake.onAttach = (req, _) async => fail('must not reattach');
    final rec = _Recorder();
    await newClient().ask(question: 'follow-up', conversationId: 'existing-conv', handlers: rec.handlers);
    await rec.done.future;
    expect(rec.errors.single, contains('服务器连接中断'));
    expect(fake.gets, isEmpty);
    expect(rec.runGone, isFalse);
  });

  test('a silent (half-open) connection is dropped and resumed from the last event', () async {
    fake.onAttach = (req, n) async {
      _FakeServer.sse(req);
      if (n == 1) {
        req.response.write('id: 4\ndata: {"type": "delta", "text": "before "}\n\n');
        await req.response.flush(); // then silence: no keepalives, no close
        return;
      }
      req.response.write('id: 5\ndata: {"type": "delta", "text": "after"}\n\n');
      req.response.write('id: 6\ndata: {"type": "done"}\n\n');
      await req.response.close();
    };
    final rec = _Recorder();
    await newClient(idle: const Duration(milliseconds: 300))
        .attach(conversationId: 'conv-4', after: 3, handlers: rec.handlers);
    await rec.done.future;
    expect(fake.gets.map((u) => u.queryParameters['after']), ['3', '4']);
    expect(rec.deltas.join(), 'before after');
  });

  test('reconnect() resumes immediately from the last event', () async {
    fake.onAttach = (req, n) async {
      _FakeServer.sse(req);
      if (n == 1) {
        req.response.write('id: 1\ndata: {"type": "delta", "text": "a"}\n\n');
        await req.response.flush(); // keeps streaming (connection stays open)
        return;
      }
      req.response.write('id: 2\ndata: {"type": "done"}\n\n');
      await req.response.close();
    };
    final rec = _Recorder();
    final client = newClient();
    unawaited(client.attach(conversationId: 'conv-5', handlers: rec.handlers));
    for (var i = 0; rec.deltas.isEmpty && i < 200; i++) {
      await Future.delayed(const Duration(milliseconds: 10));
    }
    client.reconnect(); // app came back to the foreground
    await rec.done.future.timeout(const Duration(seconds: 2));
    expect(fake.gets.map((u) => u.queryParameters['after']), ['0', '1']);
  });
}
