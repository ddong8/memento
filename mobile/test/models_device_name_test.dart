import 'package:flutter_test/flutter_test.dart';
import 'package:memento_mobile/models/device.dart';

void main() {
  test('device names drop the .local suffix and name the platform', () {
    expect(splitDeviceName('haixingdeMac-mini.local (Darwin)'), ('haixingdeMac-mini', 'macOS'));
    expect(splitDeviceName('DESKTOP-KR9IPP4 (Windows)'), ('DESKTOP-KR9IPP4', 'Windows'));
    expect(splitDeviceName('nas'), ('nas', null));
    expect(splitDeviceName('box ()'), ('box', null));
  });
}
