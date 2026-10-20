#!/usr/bin/env python3
"""
Zero-Config UPnP / IGD Port Mapper for Memento.
Uses purely Python standard library (no external dependencies).
Automatically discovers the home router via SSDP multicast and maps the port.
"""

import sys
import socket
import urllib.request
import xml.etree.ElementTree as ET


def get_local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("223.5.5.5", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def discover_router_control_url() -> str | None:
    ssdp_request = (
        "M-SEARCH * HTTP/1.1\r\n"
        "HOST: 239.255.255.250:1900\r\n"
        'MAN: "ssdp:discover"\r\n'
        "MX: 2\r\n"
        "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n"
        "\r\n"
    ).encode("utf-8")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.settimeout(3.0)
    try:
        sock.sendto(ssdp_request, ("239.255.255.250", 1900))
        while True:
            try:
                data, _ = sock.recvfrom(4096)
                response = data.decode("utf-8", errors="ignore")
                for line in response.splitlines():
                    if line.lower().startswith("location:"):
                        location = line.split(":", 1)[1].strip()
                        return parse_control_url(location)
            except socket.timeout:
                break
    except Exception as e:
        print(f"[-] SSDP 组播发现异常: {e}")
    finally:
        sock.close()
    return None


def parse_control_url(location_url: str) -> str | None:
    try:
        req = urllib.request.Request(location_url, headers={"User-Agent": "MementoUPnP"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            xml_data = resp.read()

        root = ET.fromstring(xml_data)
        # Find controlURL for WANIPConnection or WANPPPConnection
        for service in root.iter():
            if service.tag.endswith("service"):
                service_type = ""
                control_url = ""
                for child in service:
                    if child.tag.endswith("serviceType"):
                        service_type = child.text or ""
                    elif child.tag.endswith("controlURL"):
                        control_url = child.text or ""

                if "WANIPConnection" in service_type or "WANPPPConnection" in service_type:
                    if control_url.startswith("http"):
                        return control_url
                    # Combine with base url
                    from urllib.parse import urljoin
                    return urljoin(location_url, control_url)
    except Exception as e:
        print(f"[-] 解析路由器设备描述失败: {e}")
    return None


def add_port_mapping(control_url: str, port: int, local_ip: str) -> bool:
    soap_body = f"""<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>{port}</NewExternalPort>
      <NewProtocol>TCP</NewProtocol>
      <NewInternalPort>{port}</NewInternalPort>
      <NewInternalClient>{local_ip}</NewInternalClient>
      <NewEnabled>1</NewEnabled>
      <NewPortMappingDescription>Memento-Direct</NewPortMappingDescription>
      <NewLeaseDuration>0</NewLeaseDuration>
    </u:AddPortMapping>
  </s:Body>
</s:Envelope>"""

    headers = {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPAction": '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"',
    }

    try:
        req = urllib.request.Request(control_url, data=soap_body.encode("utf-8"), headers=headers)
        with urllib.request.urlopen(req, timeout=4) as resp:
            return resp.status in (200, 204)
    except Exception as e:
        # Fallback to WANPPPConnection if needed
        try:
            headers["SOAPAction"] = '"urn:schemas-upnp-org:service:WANPPPConnection:1#AddPortMapping"'
            body_ppp = soap_body.replace("WANIPConnection:1", "WANPPPConnection:1")
            req = urllib.request.Request(control_url, data=body_ppp.encode("utf-8"), headers=headers)
            with urllib.request.urlopen(req, timeout=4) as resp:
                return resp.status in (200, 204)
        except Exception:
            pass
        print(f"[-] UPnP 映射通知响应: {e}")
        return False


def main():
    target_port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    local_ip = get_local_ip()
    print(f"[*] 检测到本机局域网 IP: {local_ip}，目标端口: {target_port}")
    print("[*] 正在向家庭局域网组播嗅探主路由器 (UPnP/SSDP)...")

    control_url = discover_router_control_url()
    if not control_url:
        print("[-] 未在局域网发现支持 UPnP 的路由器（路由器可能未开启 UPnP 或处于全桥接）。")
        print("[+] 系统已切换为纯内网 mDNS + 动态 IPv6 嗅探模式，无需担心。")
        return

    print(f"[+] 发现路由器 UPnP 控制端点: {control_url}")
    print(f"[*] 正在请求路由器自动放行端口 {target_port} -> {local_ip}:{target_port} ...")
    success = add_port_mapping(control_url, target_port, local_ip)
    if success:
        print(f"[✓] 成功！主路由器已自动完成端口映射 ({target_port})，外部无需手动配置防火墙！")
    else:
        print("[-] 路由器拒绝了 UPnP 自动打洞，系统将使用自动 IPv6 直连通道与云端中继。")


if __name__ == "__main__":
    main()
