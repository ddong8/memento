class Device {
  final String deviceId;
  final String name;
  final String? platform;
  final String? status;
  final String? lastSeen;
  final String? ip;
  final bool isOnline;

  Device({
    required this.deviceId,
    required this.name,
    this.platform,
    this.status,
    this.lastSeen,
    this.ip,
    this.isOnline = false,
  });

  factory Device.fromJson(Map<String, dynamic> json) {
    final status = json['status'] as String? ?? 'offline';
    final isOnline = status == 'online' || json['is_online'] == true;
    return Device(
      deviceId: json['device_id'] as String? ?? '',
      name: json['name'] as String? ?? 'Unknown',
      platform: json['platform'] as String?,
      status: status,
      lastSeen: json['last_seen'] as String?,
      ip: json['ip'] as String?,
      isOnline: isOnline,
    );
  }
}
