import re
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')

class Account(Strict):
    id: str = Field(pattern=r'^[a-z][a-z0-9_]{0,47}$')
    name: str = Field(min_length=1, max_length=80)
    kind: Literal['device', 'client']
    device_id: str = Field(default='', pattern=r'^[a-z0-9_]{0,48}$')
    extension: str = Field(pattern=r'^[0-9]{2,16}$')
    password: str = Field(min_length=16, max_length=128, pattern=r'^[A-Za-z0-9_-]+$')
    sms_enabled: bool = True
    voice_enabled: bool = True
    enabled: bool = True

class Device(Strict):
    id: str = Field(pattern=r'^[a-z][a-z0-9_]{0,47}$')
    name: str = Field(min_length=1, max_length=80)

class Group(Strict):
    id: str = Field(pattern=r'^[a-z][a-z0-9_]{0,47}$')
    name: str = Field(min_length=1, max_length=80)
    members: list[str] = Field(min_length=1, max_length=64)

class Route(Strict):
    id: str = Field(pattern=r'^[a-z][a-z0-9_]{0,47}$')
    name: str = Field(min_length=1, max_length=80)
    medium: Literal['voice', 'sms']
    direction: Literal['inbound', 'outbound']
    sources: list[str] = Field(min_length=1, max_length=128)
    match: Literal['any', 'exact', 'prefix'] = 'any'
    number: str = Field(default='', pattern=r'^\+?[0-9]{0,24}$')
    priority: int = Field(default=100, ge=0, le=999999)
    target_type: Literal['account', 'group'] = 'account'
    target: str = Field(pattern=r'^[a-z][a-z0-9_]{0,47}$')
    enabled: bool = True

class Settings(Strict):
    hostname: str = Field(default='sip.example.com', max_length=253)
    sip_tls_port: int = Field(default=5061, ge=1024, le=65535)
    rtp_start: int = Field(default=20000, ge=1024, le=65000)
    rtp_end: int = Field(default=20199, ge=1025, le=65535)
    realm: str = Field(default='sip-gateway', pattern=r'^[A-Za-z0-9_.-]{1,64}$')
    register_interval: int = Field(default=300, ge=60, le=3600)
    sms_ttl: int = Field(default=604800, ge=60, le=2592000)

    @field_validator('hostname')
    @classmethod
    def hostname_valid(cls, value):
        if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?', value):
            raise ValueError('invalid DNS hostname')
        return value.lower()

class Login(Strict):
    username: str
    password: str

class Ingest(Strict):
    account: str
    recipient: str = Field(pattern=r'^\+?[0-9]{1,24}$')
    sender: str = Field(default='', max_length=64)
    content: str = Field(min_length=1, max_length=4096)
    delivery_id: str = Field(min_length=1, max_length=128, pattern=r'^[A-Za-z0-9_.:-]+$')

class Completion(Strict):
    delivery_id: str
    code: int = Field(ge=0, le=699)
