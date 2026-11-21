"""Local HTTPS certificates so Safari on the iPhone allows location access.

A small private "certificate authority" is created once (certs/ca.crt). You
install that on the iPhone one time. Each server start then issues a fresh
certificate for this computer's current IP addresses, signed by that CA, so
the phone keeps trusting it even when the IP changes.
"""

import datetime as dt
import ipaddress
import socket
import ssl
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def local_ips() -> list[str]:
    ips = {"127.0.0.1", "192.168.137.1"}  # 192.168.137.1 = Windows Mobile Hotspot
    try:
        ips.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass
    for target in ("192.168.0.10", "8.8.8.8"):  # which interface would reach these?
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect((target, 80))
                ips.add(s.getsockname()[0])
        except OSError:
            pass
    return sorted(ip for ip in ips if not ip.startswith("169.254."))


def _key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _write(path: Path, data: bytes):
    path.write_bytes(data)


def ensure_ca(folder: Path):
    folder.mkdir(exist_ok=True)
    key_p, crt_p = folder / "ca.key", folder / "ca.crt"
    if key_p.exists() and crt_p.exists():
        key = serialization.load_pem_private_key(key_p.read_bytes(), None)
        return key, x509.load_pem_x509_certificate(crt_p.read_bytes())
    key = _key()
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"OBD Dash local CA ({socket.gethostname()})")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True,
                                         content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False,
                                         encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    _write(key_p, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption()))
    _write(crt_p, cert.public_bytes(serialization.Encoding.PEM))
    return key, cert


def server_context(folder: Path, ips: list[str]) -> ssl.SSLContext:
    ca_key, ca_cert = ensure_ca(folder)
    key = _key()
    now = dt.datetime.now(dt.timezone.utc)
    sans = [x509.DNSName("localhost"), x509.DNSName(socket.gethostname())]
    sans += [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "OBD Dash")]))
            .issuer_name(ca_cert.subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            # iOS rejects server certificates valid for more than 825 days.
            .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=800))
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    key_p, crt_p = folder / "server.key", folder / "server.crt"
    _write(key_p, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption()))
    _write(crt_p, cert.public_bytes(serialization.Encoding.PEM) + ca_cert.public_bytes(serialization.Encoding.PEM))
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(crt_p, key_p)
    return ctx
